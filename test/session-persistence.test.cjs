'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('work order, Sandstalk and performance reuse valid business sessions after a full process restart', {timeout:50000}, async()=>{
    const profile=fs.mkdtempSync(path.join(os.tmpdir(),'electron-lark-session-restart-'));
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    try {
        for (const phase of ['seed','verify']) {
            const {stdout,stderr}=await promisify(execFile)(require('electron'),[
                path.join(__dirname,'fixtures/session-persistence.cjs'),profile,phase
            ],{timeout:24000,env});
            assert(stdout.includes('PASS persistence phase '+phase),stderr||stdout);
        }
    } finally {
        fs.rmSync(profile,{recursive:true,force:true});
    }
});
