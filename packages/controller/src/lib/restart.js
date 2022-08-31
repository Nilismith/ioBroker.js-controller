/**
 * @fileOverview restart the controller
 * @author bluefox
 * @version 0.1
 */
'use strict';

/** @module restart */
// const fs    = require('fs-extra');
// const tools = require('./tools.js');
const { spawn } = require('child_process');
const os = require('os');

function restart(callback) {
    let cmd;
    let args;
    if (os.platform() === 'win32') {
        // On Windows, we execute the controller entry point directly
        cmd = 'iobroker.bat';
        args = ['restart'];
    } else {
        // Unix has a global iobroker binary that delegates to the init system
        // We need to call that, so we don't have two instances of ioBroker running
        cmd = 'iobroker';
        args = ['restart'];
    }
    const child = spawn(cmd, args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true
    });
    child.unref();
    if (typeof callback === 'function') {
        setTimeout(() => callback(), 500);
    } else {
        setTimeout(() => process.exit(), 500);
    }
}

if (require.main !== module) {
    module.exports = restart;
} else {
    restart();
}