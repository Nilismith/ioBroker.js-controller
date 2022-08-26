/**
 *      Upload adapter files into DB
 *
 *      Copyright 2013-2022 bluefox <dogafox@gmail.com>
 *
 *      MIT License
 *
 */

import * as fs from 'fs-extra';
import { tools } from '@iobroker/js-controller-common';
import deepClone from 'deep-clone';
import { isDeepStrictEqual } from 'util';
import axios from 'axios';
import mime from 'mime';
import { join } from 'path';
import type { Client as StatesRedisClient } from '@iobroker/db-states-redis';
import type { Client as ObjectsRedisClient } from '@iobroker/db-objects-redis';
import type { InternalLogger } from '@iobroker/js-controller-common/build/lib/common/tools';

const hostname = tools.getHostName();

export interface CLIUploadOptions {
    states: StatesRedisClient;
    objects: ObjectsRedisClient;
}

interface File {
    adapter: string;
    path: string;
}

interface Logger extends InternalLogger {
    log(message: string): void;
}

export class Upload {
    private readonly states: StatesRedisClient;
    private readonly objects: ObjectsRedisClient;
    private readonly regApp: RegExp;
    private callbackId: number;
    private readonly sendToHostFromCliAsync: (...args: any[]) => Promise<any>;
    private callbacks?: Record<string, any>;
    private lastProgressUpdate: number;

    constructor(_options: CLIUploadOptions) {
        const options = _options || {};

        if (!options.states) {
            throw new Error('Invalid arguments: states is missing');
        }
        if (!options.objects) {
            throw new Error('Invalid arguments: objects is missing');
        }

        this.states = options.states;
        this.objects = options.objects;
        this.callbackId = 1;
        this.regApp = new RegExp('/' + tools.appName.replace(/\./g, '\\.') + '\\.', 'i');
        this.sendToHostFromCliAsync = tools.promisifyNoError(this.sendToHostFromCli);
        this.lastProgressUpdate = Date.now();
    }

    async checkHostsIfAlive(hosts: string[]): Promise<string[]> {
        const result = [];
        if (hosts) {
            for (const host of hosts) {
                const state = await this.states.getStateAsync(`${host}.alive`);
                if (state && state.val) {
                    result.push(host);
                }
            }
        }
        return result;
    }

    async getHosts(onlyAlive: boolean): Promise<string[]> {
        const hosts = [];
        try {
            // @ts-expect-error should be fixed with #1917
            const arr = await this.objects.getObjectListAsync({
                startkey: 'system.host.',
                endkey: 'system.host.\u9999'
            });
            if (arr && arr.rows) {
                for (const row of arr.rows) {
                    if (row.value.type !== 'host') {
                        continue;
                    }
                    hosts.push(row.value._id);
                }
            }
        } catch (e) {
            // ignore
            console.warn(`Cannot read hosts: ${e.message}`);
        }

        if (onlyAlive) {
            return this.checkHostsIfAlive(hosts);
        } else {
            return hosts;
        }
    }

    // Check if some adapters must be restarted and restart them
    async checkRestartOther(adapter: string): Promise<void> {
        const adapterDir = tools.getAdapterDir(adapter);

        if (!adapterDir) {
            console.error(`Adapter directory of adapter "${adapter}" not found`);
            return;
        }

        try {
            const adapterConf = await fs.readJSON(join(adapterDir, 'io-package.json'));
            if (adapterConf.common.restartAdapters) {
                if (!Array.isArray(adapterConf.common.restartAdapters)) {
                    // its not an array, now it can only be a single adapter as string
                    if (typeof adapterConf.common.restartAdapters !== 'string') {
                        return;
                    }
                    adapterConf.common.restartAdapters = [adapterConf.common.restartAdapters];
                }

                if (adapterConf.common.restartAdapters.length && adapterConf.common.restartAdapters[0]) {
                    const instances = await tools.getAllInstances(adapterConf.common.restartAdapters, this.objects);
                    if (instances && instances.length) {
                        for (const instance of instances) {
                            try {
                                const obj = await this.objects.getObjectAsync(instance);
                                // if instance is enabled
                                if (obj && obj.common && obj.common.enabled) {
                                    obj.common.enabled = false; // disable instance

                                    obj.from = `system.host.${tools.getHostName()}.cli`;
                                    obj.ts = Date.now();

                                    await this.objects.setObjectAsync(obj._id, obj);

                                    obj.common.enabled = true; // enable instance
                                    obj.ts = Date.now();

                                    await this.objects.setObjectAsync(obj._id, obj);
                                    console.log(`Adapter "${obj._id}" restarted.`);
                                }
                            } catch (e) {
                                console.error(`Cannot restart adapter "${instance}": ${e.message}`);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`Cannot parse ${adapterDir}/io-package.json: ${e.message}`);
        }
    }

    sendToHostFromCli(
        host: string,
        command: string,
        message: ioBroker.MessagePayload,
        callback: ioBroker.MessageCallback | null
    ): void {
        const time = Date.now();
        const from = `system.host.${hostname}_cli_${time}`;

        const timeout = setTimeout(() => {
            callback && callback();
            callback = null;
            this.states.unsubscribeMessage(from);
            // @ts-expect-error todo: I don't think this works
            this.states.onChange = null;
        }, 60000);

        // @ts-expect-error todo: I don't think this works
        this.states.onChange = (id, msg) => {
            if (id.endsWith(from)) {
                if (msg.command === 'log' || msg.command === 'error' || msg.command === 'warn') {
                    // @ts-expect-error
                    console[msg.command](`${host} -> ${msg.text}`);
                } else if (callback) {
                    callback(msg && msg.message);
                    callback = null;
                    clearTimeout(timeout);
                    this.states.unsubscribeMessage(from);
                    // @ts-expect-error
                    this.states.onChange = null;
                }
            }
        };

        this.states.subscribeMessage(from, () => {
            const obj: Omit<ioBroker.Message, '_id'> = {
                command,
                message: message,
                from: `system.host.${hostname}_cli_${time}`,
                callback: {
                    message,
                    id: this.callbackId++,
                    ack: false,
                    time
                }
            };

            if (this.callbackId > 0xffffffff) {
                this.callbackId = 1;
            }
            this.callbacks = this.callbacks || {};
            this.callbacks[`_${obj.callback.id}`] = { cb: callback };

            // we cannot receive answers from hosts in CLI, so this command is "fire and forget"
            // @ts-expect-error fixed with #1917
            this.states.pushMessage(host, obj);
        });
    }

    async uploadAdapterFullAsync(adapters: string[]): Promise<void> {
        if (adapters && adapters.length) {
            const liveHosts = await this.getHosts(true);
            for (const adapter of adapters) {
                // Find the host which has this adapter
                const instances = await tools.getInstances(adapter, this.objects, true);
                // try to find instance on this host
                let instance = instances.find(obj => obj && obj.common && obj.common.host === hostname);

                // try to find enabled instance on live host
                instance =
                    instance ||
                    instances.find(
                        obj => obj && obj.common && obj.common.enabled && liveHosts.includes(obj.common.host)
                    );

                // try to find any instance
                instance = instance || instances.find(obj => obj && obj.common && liveHosts.includes(obj.common.host));

                if (instance && instance.common.host !== hostname) {
                    console.log(`Send upload command to host "${instance.common.host}"... `);
                    // send upload message to the host
                    const response = await this.sendToHostFromCliAsync(instance.common.host, 'upload', adapter);
                    if (response) {
                        console.log('Upload result: ' + response.result);
                    } else {
                        console.error('No answer from ' + instance.common.host);
                    }
                } else {
                    if (!instance) {
                        // no one alive instance found
                        const adapterDir = tools.getAdapterDir(adapter);
                        if (!adapterDir || !fs.existsSync(adapterDir)) {
                            console.warn(
                                `No alive host found which has the adapter ${adapter} installed! No upload possible. Skipped.`
                            );
                            continue;
                        }
                    }

                    // try to upload on this host. It will print an error if the adapter directory not found
                    await this.uploadAdapter(adapter, true, true);
                    await this.upgradeAdapterObjects(adapter);
                    await this.uploadAdapter(adapter, false, true);
                }
            }
        }
    }

    /**
     * Uploads a file
     */
    async uploadFile(source: string, target: string): Promise<string> {
        target = target.replace(/\\/g, '/');
        source = source.replace(/\\/g, '/');
        if (target[0] === '/') {
            target = target.substring(1);
        }
        if (target[target.length - 1] === '/') {
            let name = source.split('/').pop()!;
            name = name.split('?')[0];
            if (!name.includes('.')) {
                name = 'index.html';
            }
            target += name;
        }
        const parts = target.split('/');
        const adapter = parts[0];
        parts.splice(0, 1);
        target = parts.join('/');

        if (source.match(/^http:\/\/|^https:\/\//)) {
            try {
                const result = await axios(source, {
                    responseType: 'arraybuffer',
                    validateStatus: status => status === 200
                });
                if (result && result.data) {
                    await this.objects.writeFileAsync(adapter, target, result.data);
                } else {
                    console.error(`Empty response from URL "${source}"`);
                    throw new Error(`Empty response from URL "${source}"`);
                }
            } catch (err) {
                let result;
                if (err.response) {
                    // The request was made and the server responded with a status code
                    // that falls out of the range of 2xx
                    result = err.response.data || err.response.status;
                } else if (err.request) {
                    // The request was made but no response was received
                    // `err.request` is an instance of XMLHttpRequest in the browser and an instance of
                    // http.ClientRequest in node.js
                    result = err.request;
                } else {
                    // Something happened in setting up the request that triggered an Error
                    result = err.message;
                }
                console.error(`Cannot get URL "${source}": ${result}`);
                throw new Error(result);
            }
        } else {
            try {
                await this.objects.writeFileAsync(adapter, target, fs.readFileSync(source));
            } catch (err) {
                console.error(`Cannot read file "${source}": ${err.message}`);
                throw err;
            }
        }

        return `${adapter}/${target}`;
    }

    async eraseFiles(files: any[], logger: Logger | typeof console): Promise<void> {
        if (files && files.length) {
            for (const file of files) {
                try {
                    // @ts-expect-error should be fixed with #1917
                    await this.objects.unlinkAsync(file.adapter, file.path);
                } catch (err) {
                    logger.error(`Cannot delete file "${file.path}": ${err}`);
                }
            }
        }
    }

    /**
     * Collect Files of an adapter specific directory from the iobroker storage
     *
     * @param adapter Adaptername
     * @param path path in the adapterspecific storage space
     * @param logger Logger instance
     */
    async collectExistingFilesToDelete(
        adapter: string,
        path: string,
        logger: Logger | typeof console
    ): Promise<{ filesToDelete: File[]; dirs: File[] }> {
        let _files: File[] = [];
        let _dirs: File[] = [];
        let files: ioBroker.ReadDirResult[];
        try {
            // @ts-expect-error should be fixed with #1917
            files = await this.objects.readDirAsync(adapter, path);
        } catch {
            // ignore err
            files = [];
        }

        if (files && files.length) {
            for (const file of files) {
                if (file.file === '.' || file.file === '..') {
                    continue;
                }
                const newPath = path + file.file;
                if (file.isDir) {
                    if (!_dirs.find(e => e.path === newPath)) {
                        _dirs.push({ adapter, path: newPath });
                    }
                    try {
                        const result = await this.collectExistingFilesToDelete(adapter, `${newPath}/`, logger);
                        if (result.filesToDelete) {
                            _files = _files.concat(result.filesToDelete);
                        }

                        _dirs = _dirs.concat(result.dirs);
                    } catch (err) {
                        logger.warn(`Cannot delete folder "${adapter}${newPath}/": ${err.message}`);
                    }
                } else if (!_files.find(e => e.path === newPath)) {
                    _files.push({ adapter, path: newPath });
                }
            }
        }

        return { filesToDelete: _files, dirs: _dirs };
    }

    async upload(
        adapter: string,
        isAdmin: boolean,
        files: string[],
        id: string,
        rev: any,
        logger: Logger | typeof console
    ): Promise<string> {
        const uploadID = `system.adapter.${adapter}.upload`;

        await this.states.setStateAsync(uploadID, { val: 0, ack: true });

        for (let f = 0; f < files.length; f++) {
            const file = files[f];
            // do not upload '.gitignore' files. Todo: add other exceptions
            if (file === '.gitignore') {
                continue;
            }

            const mimeType = mime.getType(file);
            let attNameArr = file.split(this.regApp);
            // try to find anyway if adapter is not lower case
            if (attNameArr.length === 1 && file.toLowerCase().includes(tools.appName.toLowerCase())) {
                attNameArr = ['', file.substring(tools.appName.length + 2)];
            }

            let attName = attNameArr.pop()!;
            attName = attName.split('/').slice(2).join('/');
            if (files.length - f > 100) {
                (!f || !((files.length - f - 1) % 50)) &&
                    logger.log(`upload [${files.length - f - 1}] ${id} ${file} ${attName} ${mimeType}`);
            } else if (files.length - f - 1 > 20) {
                (!f || !((files.length - f - 1) % 10)) &&
                    logger.log(`upload [${files.length - f - 1}] ${id} ${file} ${attName} ${mimeType}`);
            } else {
                logger.log(`upload [${files.length - f - 1}] ${id} ${file} ${attName} ${mimeType}`);
            }

            // Update upload indicator
            if (!isAdmin) {
                const now = Date.now();
                if (now - this.lastProgressUpdate > 1000) {
                    this.lastProgressUpdate = now;
                    await this.states.setStateAsync(uploadID, {
                        val: Math.round((1000 * (files.length - f)) / files.length) / 10,
                        ack: true
                    });
                }
            }

            try {
                await new Promise<void>((resolve, reject) => {
                    const stream = fs.createReadStream(file);
                    stream.on('error', e => reject(e));
                    stream.pipe(
                        this.objects.insert(id, attName, null, mimeType || {}, { rev }, (err, res) => {
                            err && console.log(err);
                            if (res) {
                                // @ts-expect-error it always returns null, check it also rev seems to do nothing
                                rev = res.rev;
                            }
                            resolve();
                        })
                    );
                });
            } catch (e) {
                console.error(`Error: Cannot upload ${file}: ${e.message}`);
            }
        }

        // Set upload progress to 0;
        if (!isAdmin && files.length) {
            await this.states.setStateAsync(uploadID, { val: 0, ack: true });
        }

        return adapter;
    }

    // Read synchronous all files recursively from local directory
    walk(dir: string, _results?: string[]): string[] {
        const results = _results || [];
        try {
            if (fs.existsSync(dir)) {
                const list = fs.readdirSync(dir);
                list.map(file => {
                    const stat = fs.statSync(`${dir}/${file}`);
                    if (stat.isDirectory()) {
                        this.walk(`${dir}/${file}`, results);
                    } else {
                        if (!file.endsWith('.npmignore') && !file.endsWith('.gitignore')) {
                            results.push(`${dir}/${file}`);
                        }
                    }
                });
            }
        } catch (err) {
            console.error(err);
        }

        return results;
    }

    /**
     * Upload given adapter
     */
    async uploadAdapter(
        adapter: string,
        isAdmin: boolean,
        forceUpload: boolean,
        subTree?: string,
        _logger?: Logger
    ): Promise<string> {
        const id = adapter + (isAdmin ? '.admin' : '');
        const adapterDir = tools.getAdapterDir(adapter);
        let dir = adapterDir ? adapterDir + (isAdmin ? '/admin' : '/www') : '';

        const logger = _logger || console;

        if (subTree && dir) {
            dir += `/${subTree}`;
        }
        if (adapterDir === null || !fs.existsSync(adapterDir)) {
            console.log(
                `INFO: Directory "${
                    adapterDir || `for ${adapter}${isAdmin ? '.admin' : ''}`
                }" was not found! Nothing was uploaded or deleted.`
            );
            return adapter;
        }

        let cfg;
        try {
            cfg = await fs.readJSON(`${adapterDir}/io-package.json`);
        } catch (err) {
            // file not parsable or does not exist
            console.error(`Could not read io-package.json: ${err.message}`);
        }

        if (!fs.existsSync(dir)) {
            // www folder have not all adapters. So show warning only for admin folder
            (isAdmin || (cfg && cfg.common && cfg.common.onlyWWW)) &&
                console.log(
                    `INFO: Directory "${
                        dir || `for ${adapter}${isAdmin ? '.admin' : ''}`
                    }" was not found! Nothing was uploaded or deleted.`
                );

            if (isAdmin) {
                return adapter;
            } else {
                await this.checkRestartOther(adapter);
                return adapter;
            }
        }

        // check for common.wwwDontUpload (required for legacy adapters and admin)
        if (!isAdmin && cfg && cfg.common && cfg.common.wwwDontUpload) {
            return adapter;
        }

        // Create "upload progress" object if not exists
        if (!isAdmin) {
            let obj;
            const uploadID = `system.adapter.${adapter}.upload`;
            try {
                obj = await this.objects.getObjectAsync(uploadID);
            } catch {
                // ignore
            }
            if (!obj) {
                await this.objects.setObjectAsync(uploadID, {
                    _id: uploadID,
                    type: 'state',
                    common: {
                        name: `${adapter}.upload`,
                        type: 'number',
                        role: 'indicator.state',
                        unit: '%',
                        min: 0,
                        max: 100,
                        def: 0,
                        desc: 'Upload process indicator',
                        read: true,
                        write: false
                    },
                    from: `system.host.${tools.getHostName()}.cli`,
                    ts: Date.now(),
                    native: {}
                });
            }
            // Set indicator to 0
            // @ts-expect-error fixed with #1917
            await this.states.setStateAsync(uploadID, 0, true);
        }

        let result;
        try {
            result = await this.objects.getObjectAsync(id);
        } catch {
            // ignore
        }
        // Read all names with subtrees from local directory
        const files = this.walk(dir);
        if (!result) {
            // @ts-expect-error types needed admin is not allowed for meta but it should be allowed
            await this.objects.setObjectAsync(id, {
                type: 'meta',
                common: {
                    name: id.split('.').pop()!,
                    type: isAdmin ? 'admin' : 'www'
                },
                from: `system.host.${tools.getHostName()}.cli`,
                ts: Date.now(),
                native: {}
            });
            forceUpload = true;
        }

        if (forceUpload) {
            if (cfg && cfg.common && cfg.common.eraseOnUpload) {
                const { filesToDelete } = await this.collectExistingFilesToDelete(
                    isAdmin ? adapter + '.admin' : adapter,
                    '/',
                    logger
                );
                // delete old files, before upload of new
                await this.eraseFiles(filesToDelete, logger);
            }
            if (!isAdmin) {
                await this.checkRestartOther(adapter);
                await new Promise<void>(resolve => setTimeout(() => resolve(), 25));
                // @ts-expect-error TODO rev is not required and should not exist on an object?
                await this.upload(adapter, isAdmin, files, id, result && result.rev, logger);
            } else {
                // @ts-expect-error TODO rev is not required and should not exist on an object?
                await this.upload(adapter, isAdmin, files, id, result && result.rev, logger);
            }
        }
        return adapter;
    }

    extendNative(target: Record<string, any>, additional: Record<string, any>): Record<string, any> {
        if (tools.isObject(additional)) {
            for (const attr of Object.keys(additional)) {
                if (target[attr] === undefined) {
                    target[attr] = additional[attr];
                } else if (typeof additional[attr] === 'object' && !(additional[attr] instanceof Array)) {
                    try {
                        target[attr] = target[attr] || {};
                    } catch {
                        console.warn(`Cannot update attribute ${attr} of native`);
                    }
                    if (typeof target[attr] === 'object' && target[attr] !== null) {
                        this.extendNative(target[attr], additional[attr]);
                    }
                }
            }
        }
        return target;
    }

    extendCommon(
        target: Record<string, any>,
        additional: Record<string, any>,
        instance: string
    ): ioBroker.InstanceCommon {
        if (tools.isObject(additional)) {
            const preserveAttributes = [
                'title',
                'schedule',
                'restartSchedule',
                'mode',
                'loglevel',
                'enabled',
                'custom'
            ];

            for (const attr of Object.keys(additional)) {
                // preserve these attributes, except, they werde undefined before and preserve titleLang if current titleLang is of type string (changed by user)
                if (preserveAttributes.includes(attr) || (attr === 'titleLang' && typeof target[attr] === 'string')) {
                    if (target[attr] === undefined) {
                        target[attr] = additional[attr];
                    }
                } else if (typeof additional[attr] !== 'object' || additional[attr] instanceof Array) {
                    try {
                        target[attr] = additional[attr];

                        // dataFolder can have wildcards
                        if (attr === 'dataFolder' && target.dataFolder && target.dataFolder.includes('%INSTANCE%')) {
                            target.dataFolder = target.dataFolder.replace(/%INSTANCE%/g, instance);
                        }
                    } catch {
                        console.warn(`Cannot update attribute ${attr} of common`);
                    }
                } else {
                    target[attr] = target[attr] || {};
                    if (typeof target[attr] !== 'object') {
                        target[attr] = {}; // here we clean the simple value with object
                    }

                    this.extendCommon(target[attr], additional[attr], instance);
                }
            }
        }
        return target as ioBroker.InstanceCommon;
    }

    async _upgradeAdapterObjectsHelper(
        name: string,
        ioPack: Record<string, any>,
        hostname: string,
        logger: Logger | typeof console
    ): Promise<string> {
        // Update all instances of this host
        const res = await this.objects.getObjectViewAsync('system', 'instance', {
            startkey: `system.adapter.${name}.`,
            endkey: `system.adapter.${name}.\u9999`
        });

        if (res) {
            for (const row of res.rows) {
                if (row.value.common.host === hostname) {
                    const _obj = await this.objects.getObjectAsync(row.id);
                    const newObject = deepClone(_obj) as ioBroker.InstanceObject;

                    // all common settings should be taken from new one
                    newObject.common = this.extendCommon(
                        newObject.common,
                        ioPack.common,
                        newObject._id.split('.').pop()!
                    );
                    newObject.native = this.extendNative(newObject.native, ioPack.native);

                    // protected/encryptedNative and notifications also need to be updated
                    // @ts-expect-error TODO needs to be added to types
                    newObject.protectedNative = ioPack.protectedNative || [];
                    // @ts-expect-error TODO needs to be added to types
                    newObject.encryptedNative = ioPack.encryptedNative || [];
                    // @ts-expect-error TODO needs to be added to types
                    newObject.notifications = ioPack.notifications || [];
                    // update instanceObjects and objects
                    // @ts-expect-error TODO needs to be added to types
                    newObject.instanceObjects = ioPack.instanceObjects || [];
                    // @ts-expect-error TODO needs to be added to types
                    newObject.objects = ioPack.objects || [];

                    // @ts-expect-error TODO needs to be added to types
                    newObject.common.version = ioPack.common.version;
                    // @ts-expect-error TODO needs to be added to types
                    newObject.common.installedVersion = ioPack.common.version;
                    // @ts-expect-error TODO needs to be added to types
                    newObject.common.installedFrom = ioPack.common.installedFrom;

                    // @ts-expect-error TODO needs to be added to types
                    if (!ioPack.common.compact && newObject.common.compact) {
                        // @ts-expect-error TODO needs to be added to types
                        newObject.common.compact = ioPack.common.compact;
                    }

                    // Compare objects to reduce restarts of instances
                    if (!isDeepStrictEqual(newObject, _obj)) {
                        logger.log(`Update "${newObject._id}"`);

                        newObject.from = `system.host.${tools.getHostName()}.cli`;
                        newObject.ts = Date.now();

                        await this.objects.setObjectAsync(newObject._id, newObject);

                        // @ts-expect-error TODO: instance object is no state remove this part?
                        if (newObject.common.def !== undefined && newObject.common.def !== null) {
                            // set default state value
                            const state = await this.states.getStateAsync(newObject._id);
                            if (!state) {
                                await this.states.setStateAsync(newObject._id, {
                                    // @ts-expect-error see above
                                    val: newObject.common.def,
                                    ack: true,
                                    q: 0x40 // substitute value from device or adapter
                                });
                            }
                        }
                    }
                }
            }
        }

        // updates only "_design/system" and co "_design/*"
        if (ioPack.objects && typeof ioPack.objects === 'object') {
            for (const _id of Object.keys(ioPack.objects)) {
                if (name === 'js-controller' && !_id.startsWith('_design/')) {
                    continue;
                }

                ioPack.objects[_id].from = `system.host.${hostname}.cli`;
                ioPack.objects[_id].ts = Date.now();

                try {
                    await this.objects.setObjectAsync(ioPack.objects[_id]._id, ioPack.objects[_id]);
                } catch (err) {
                    logger.error(`Cannot update object: ${err}`);
                }
            }
        }

        return name;
    }

    /**
     * Create object from io-package json
     */
    async upgradeAdapterObjects(
        name: string,
        ioPack?: Record<string, any>,
        _logger?: Logger | typeof console
    ): Promise<string> {
        const logger = _logger || console;

        const adapterDir = tools.getAdapterDir(name);
        let ioPackFile;
        try {
            ioPackFile = fs.readJSONSync(adapterDir + '/io-package.json');
        } catch {
            if (adapterDir) {
                logger.error(`Cannot find io-package.json in ${adapterDir}`);
            } else {
                logger.error(`Cannot find io-package.json for "${name}"`);
            }
            ioPackFile = null;
        }
        ioPack = ioPack || ioPackFile;

        if (ioPack) {
            // Always update installed From from File on disk if exists and set
            if (ioPackFile && ioPackFile.common && ioPackFile.common.installedFrom) {
                ioPack.common = ioPack.common || {};
                ioPack.common.installedFrom = ioPackFile.common.installedFrom;
            }
            // Not existing? Why ever ... we recreate
            let _obj;
            try {
                _obj = await this.objects.getObject(`system.adapter.${name}`);
            } catch {
                // ignore err
            }
            const obj: Omit<ioBroker.AdapterObject, '_id'> = _obj || {
                common: ioPack.common,
                native: ioPack.native,
                type: 'adapter'
            };

            obj.common = ioPack.common || {};
            obj.native = ioPack.native || {};
            // protected/encryptedNative and notifications also need to be updated
            obj.protectedNative = ioPack.protectedNative || [];
            obj.encryptedNative = ioPack.encryptedNative || [];
            // @ts-expect-error TODO needs to be added to types
            obj.notifications = ioPack.notifications || [];
            // update instanceObjects and objects
            // @ts-expect-error TODO needs to be added to types
            obj.instanceObjects = ioPack.instanceObjects || [];
            // @ts-expect-error TODO needs to be added to types
            obj.objects = ioPack.objects || [];

            obj.type = 'adapter';

            obj.common!.installedVersion = ioPack.common.version;

            // @ts-expect-error TODO needs to be added to types
            if (obj.common!.news) {
                // @ts-expect-error TODO needs to be added to types
                delete obj.common!.news; // remove this information as it could be big, but it will be taken from repo
            }

            const hostname = tools.getHostName();

            obj.from = `system.host.${hostname}.cli`;
            obj.ts = Date.now();

            try {
                await this.objects.setObjectAsync(`system.adapter.${name}`, obj);
            } catch (err) {
                logger.error(`Cannot set system.adapter.${name}: ${err.message}`);
            }

            await this._upgradeAdapterObjectsHelper(name, ioPack, hostname, logger);
        }

        return name;
    }
}