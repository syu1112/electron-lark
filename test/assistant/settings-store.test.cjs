const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createSettingsStore} = require('../../src/assistant/settings-store');

async function setup(t, storage = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-settings-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const configFile = path.join(dir,'config.json');
  const safeStorage = {
    isEncryptionAvailable:() => true,
    encryptString:text => Buffer.from(text.split('').reverse().join('')),
    decryptString:buffer => buffer.toString().split('').reverse().join(''), ...storage
  };
  return {configFile, store:createSettingsStore({configFile,safeStorage})};
}
test('default context and runtime are separate from public credentials', async t => {
  const {store,configFile} = await setup(t);
  assert.equal((await store.readPublic()).assistant.contextLimit,10);
  await store.save({assistant:{contextLimit:0,jevApiKey:'fake-secret'}});
  await store.save({assistant:{contextLimit:50,jevApiKey:''}});
  assert.equal((await store.readRuntime()).jevApiKey,'fake-secret');
  assert.equal((await store.readPublic()).assistant.contextLimit,50);
  assert(!JSON.stringify(await store.readPublic()).includes('fake-secret'));
  assert(!(await fs.readFile(configFile,'utf8')).includes('fake-secret'));
  await store.save({assistant:{clearJevKey:true}});
  assert.equal((await store.readPublic()).assistant.hasJevKey,false);
});
test('skill selection and reasoning settings survive saves and reject malformed entries',async t=>{
  const {store}=await setup(t);
  const skills=[{id:'writing',name:'回复风格',path:'/tmp/writing/SKILL.md'}];
  await store.save({assistant:{skills,codexReasoningEffort:'high'}});
  await store.save({assistant:{contextLimit:5}});
  assert.deepEqual((await store.readRuntime()).skills,skills);
  assert.equal((await store.readPublic()).assistant.codexReasoningEffort,'high');
  for(const invalid of [[{...skills[0],path:'relative/SKILL.md'}],[...skills,...skills],[{...skills[0],path:'/tmp/not-a-skill.txt'}]])await assert.rejects(store.save({assistant:{skills:invalid}}),{code:'SETTINGS_INVALID'});
  await assert.rejects(store.save({assistant:{codexReasoningEffort:'high\nmalformed'}}),{code:'SETTINGS_INVALID'});
});
test('invalid ranges and endpoints do not alter saved settings', async t => {
  const {store} = await setup(t);
  for(const contextLimit of [-1,51,1.5,NaN,'10']) {
    await assert.rejects(store.save({assistant:{contextLimit}}),{code:'SETTINGS_INVALID'});
  }
  for(const jevEndpoint of ['http://example.com','https://user:pass@example.com','bad']) {
    await assert.rejects(store.save({assistant:{jevEndpoint}}),{code:'SETTINGS_INVALID'});
  }
  assert.equal((await store.readPublic()).assistant.revision,0);
});
test('default reply mode persists independently and rejects unknown modes',async t=>{
  const {store}=await setup(t);assert.equal((await store.readPublic()).assistant.defaultReplyMode,'professional');
  await store.save({assistant:{defaultReplyMode:'pushback'}});await store.save({assistant:{contextLimit:3}});
  assert.equal((await store.readRuntime()).defaultReplyMode,'pushback');
  await assert.rejects(store.save({assistant:{defaultReplyMode:'invalid'}}),{code:'MODE_INVALID'});
});
test('unavailable or plaintext secure storage cannot persist a key', async t => {
  const {store,configFile} = await setup(t,{isEncryptionAvailable:()=>false});
  await assert.rejects(store.save({assistant:{jevApiKey:'fake-secret'}}),{code:'KEY_UNAVAILABLE'});
  await assert.rejects(fs.access(configFile));
  const other = await setup(t,{getSelectedStorageBackend:()=> 'basic_text'});
  await assert.rejects(other.store.save({assistant:{jevApiKey:'fake-secret'}}),{code:'KEY_UNAVAILABLE'});
});
test('concurrent updates preserve existing settings, keys, and unknown fields', async t => {
  const {store,configFile} = await setup(t);
  await fs.writeFile(configFile,JSON.stringify({startPageLink:'https://example.com',custom:42}));
  await Promise.all([store.save({assistant:{jevApiKey:'fake-secret'}}),store.save({showWarterMark:true})]);
  assert.equal((await store.readRuntime()).jevApiKey,'fake-secret');
  const saved = JSON.parse(await fs.readFile(configFile,'utf8'));
  assert.equal(saved.custom,42);
  assert.equal(saved.startPageLink,'https://example.com');
  assert.equal(saved.showWarterMark,true);
});
test('public reads never require keychain decryption and corrupted config is not overwritten',async t=>{
  const {store,configFile}=await setup(t,{decryptString:()=>{throw Error('secret detail');}});
  await store.save({assistant:{jevApiKey:'fake-secret'}});
  assert.equal((await store.readPublic()).assistant.hasJevKey,true);
  await assert.rejects(store.readRuntime(),{code:'KEY_UNAVAILABLE'});
  await fs.writeFile(configFile,'broken');
  await assert.rejects(store.save({assistant:{contextLimit:2}}),{code:'SETTINGS_INVALID'});
  assert.equal(await fs.readFile(configFile,'utf8'),'broken');
});
