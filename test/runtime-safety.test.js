const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { acquireResources, canonicalPath, withFileMutex } = require("../src/runtime-locks");
const { getProcessIdentity } = require("../src/process-identity");

const ROOT = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const resource = (value, mode = "write") => ({ type: "path", path: value, mode });
const fixtureWorkers = new Map();

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-runtime-safety-"));
  const workers = new Set();
  fixtureWorkers.set(dir, workers);
  t.after(async () => {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all([...workers].map(({ exited }) => exited));
    fixtureWorkers.delete(dir);
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, runtimeDir: path.join(dir, "runtime") };
}

function childWorker(t, args, source) {
  const child = spawn(process.execPath, ["-e", source, JSON.stringify({ root: ROOT, ...args })],
    { cwd: args.dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = [];
  let output = "";
  child.on("message", (message) => messages.push(message));
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  fixtureWorkers.get(args.dir).add({ child, exited });
  return { child, messages, exited, output: () => output, wait(type) {
    const found = messages.find((message) => message.type === type || message.type === "error");
    if (found) return found.type === "error" ? Promise.reject(new Error(found.message)) : Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Timeout waiting for ${type}: ${output}`)), 45000);
      const listener = (message) => {
        if (message.type === type) finish(null, message);
        else if (message.type === "error") finish(new Error(message.message));
      };
      function finish(error, message) {
        clearTimeout(timer); child.off("message", listener);
        if (error) reject(error); else resolve(message);
      }
      child.on("message", listener);
    });
  } };
}

const MUTEX_OWNER = `
const args=JSON.parse(process.argv[1]);
const {withFileMutex}=require(args.root+'/src/runtime-locks');
withFileMutex(args.file,async()=>{
 process.send({type:'locked'});
 await new Promise(resolve=>process.once('message',resolve));
}).then(()=>process.disconnect()).catch(e=>{process.send({type:'error',message:e.message});process.disconnect();});
`;

test("mutexes serialize independent same-PID calls, release on error, and reject recursion", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "mutex");
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 4 }, () => withFileMutex(file, async () => {
    peak = Math.max(peak, ++active);
    await sleep(20);
    active -= 1;
  })));
  assert.equal(peak, 1);
  await assert.rejects(withFileMutex(file, async () => { throw new Error("fixture failure"); }), /fixture failure/);
  await withFileMutex(file, async () => {
    await assert.rejects(withFileMutex(file, async () => {}), { code: "EDEADLOCK" });
  });
  await withFileMutex(file, async () => {});
  assert.deepEqual(await fs.readdir(`${await canonicalPath(file)}.mutex-v2`), []);
});

test("old mtime and waiting timeout cannot remove a living mutex owner", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "mutex");
  let entered, finish;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = withFileMutex(file, async () => {
    entered();
    await new Promise((resolve) => { finish = resolve; });
  });
  await ready;
  const directory = `${await canonicalPath(file)}.mutex-v2`;
  const [owner] = await fs.readdir(directory);
  await fs.utimes(path.join(directory, owner), new Date(0), new Date(0));
  try {
    await assert.rejects(withFileMutex(file, async () => assert.fail("stole live owner"), 40), { code: "ELOCKED" });
    assert.deepEqual(await fs.readdir(directory), [owner]);
  } finally { finish(); await held; }
  await withFileMutex(file, async () => {});
});

test("a killed mutex owner is recovered without an expiry delay", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "mutex");
  const owner = childWorker(t, { ...f, file }, MUTEX_OWNER);
  await owner.wait("locked");
  owner.child.kill("SIGKILL");
  await owner.exited;
  await withFileMutex(file, async () => {});
});

test("different creation identity reclaims a recycled-PID claim and lease; legacy live PID stays protected", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "mutex");
  const directory = `${await canonicalPath(file)}.mutex-v2`;
  await fs.mkdir(directory);
  const id = crypto.randomUUID();
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ id, pid: process.pid,
    processIdentity: `${await getProcessIdentity()}:previous-process`, ticket: 1 }));
  await withFileMutex(file, async () => {});
  assert.deepEqual(await fs.readdir(directory), []);
  const jobs = path.join(f.runtimeDir, "jobs");
  await fs.mkdir(jobs, { recursive: true });
  const output = path.join(f.dir, "output");
  const lease = { id, pid: process.pid, processIdentity: "previous-process", label: "fixture",
    resources: [resource(await canonicalPath(output))] };
  const leasePath = path.join(jobs, `${id}.json`);
  await fs.writeFile(leasePath, JSON.stringify(lease));
  const release = await acquireResources([resource(output)], f);
  await release();
  delete lease.processIdentity;
  await fs.writeFile(leasePath, JSON.stringify(lease));
  await assert.rejects(acquireResources([resource(output)], f), /使用中/);
  assert.ok(await fs.stat(leasePath));
});

test("failed atomic ticket publication never enters the action and cleans its claim", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "mutex");
  const directory = `${await canonicalPath(file)}.mutex-v2`;
  const original = fs.rename;
  fs.rename = async (source, destination) => {
    if (path.dirname(destination) === directory) throw Object.assign(new Error("fixture sharing violation"), { code: "EPERM" });
    return original(source, destination);
  };
  try {
    await assert.rejects(withFileMutex(file, async () => assert.fail("entered without publication")), /fixture sharing/);
  } finally { fs.rename = original; }
  assert.deepEqual(await fs.readdir(directory), []);
  await withFileMutex(file, async () => {});
});

test("nested Junctions stop safely and release leases; a root Junction remains supported", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.dir, "output"), target = path.join(f.dir, "target");
  await fs.mkdir(output); await fs.mkdir(target);
  const link = path.join(output, "category");
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(acquireResources([resource(output)], f), /配下のJunction/);
  assert.deepEqual(await fs.readdir(path.join(f.runtimeDir, "jobs")), []);
  const release = await acquireResources([resource(link)], f);
  await assert.rejects(acquireResources([resource(target, "read")], f), /使用中/);
  await release();
});

test("unavailable creation metadata does not evict a living peer", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "mutex");
  const owner = childWorker(t, { ...f, file }, MUTEX_OWNER);
  await owner.wait("locked");
  const checker = childWorker(t, { ...f, file, ownerPid: owner.child.pid }, `
const args=JSON.parse(process.argv[1]);
const cp=require('node:child_process'),fs=require('node:fs/promises');
const originalExec=cp.execFile,originalRead=fs.readFile;
cp.execFile=(file,argv,options,callback)=>{
 if(argv.some(value=>value.includes('@('+args.ownerPid+')'))){
  queueMicrotask(()=>callback(Object.assign(new Error('fixture permission denied'),{code:'EACCES'}),'',''));
  return {};
 }
 return originalExec(file,argv,options,callback);
};
cp.execFile[require('node:util').promisify.custom]=(file,argv,options)=>new Promise((resolve,reject)=>{
 cp.execFile(file,argv,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));
});
fs.readFile=async(file,...rest)=>{
 if(file==='/proc/'+args.ownerPid+'/stat') throw Object.assign(new Error('fixture permission denied'),{code:'EACCES'});
 return originalRead(file,...rest);
};
const {withFileMutex}=require(args.root+'/src/runtime-locks');
withFileMutex(args.file,async()=>{throw new Error('evicted unknown owner');},150)
 .then(()=>{process.send({type:'error',message:'unexpected admission'});process.disconnect();})
 .catch(e=>{process.send(e.code==='ELOCKED'?{type:'protected'}:{type:'error',message:e.message});process.disconnect();});
`);
  await checker.wait("protected");
  assert.equal(await checker.exited, 0, checker.output());
  const directory = `${await canonicalPath(file)}.mutex-v2`;
  assert.equal((await fs.readdir(directory)).length, 1);
  owner.child.send("release");
  assert.equal(await owner.exited, 0, owner.output());
});

test("malformed owner metadata stops admission rather than ignoring the claim", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "mutex");
  const directory = `${await canonicalPath(file)}.mutex-v2`;
  await fs.mkdir(directory);
  const name = `${crypto.randomUUID()}.json`;
  await fs.writeFile(path.join(directory, name), "{}");
  await assert.rejects(withFileMutex(file, async () => assert.fail("ignored unknown claim")), /所有者情報が不正/);
  assert.deepEqual(await fs.readdir(directory), [name]);
});

test("malformed resource metadata cannot silently bypass a read/write conflict", async (t) => {
  const f = await fixture(t);
  const jobs = path.join(f.runtimeDir, "jobs");
  await fs.mkdir(jobs, { recursive: true });
  const id = crypto.randomUUID(), output = path.join(f.dir, "output");
  const file = path.join(jobs, `${id}.json`);
  await fs.writeFile(file, JSON.stringify({ id, pid: process.pid,
    processIdentity: await getProcessIdentity(), resources: [{ type: "path", path: output }] }));
  await assert.rejects(acquireResources([resource(output, "read")], f), /管理情報が不正/);
  assert.deepEqual(await fs.readdir(jobs), [`${id}.json`]);
});

test("failed release reports a cleanup error and retries only its own orphan", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "mutex");
  const directory = `${await canonicalPath(file)}.mutex-v2`;
  const original = fs.unlink;
  fs.unlink = async (target) => {
    if (path.dirname(target) === directory && target.endsWith(".json")) {
      throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
    }
    return original(target);
  };
  try {
    let entered = 0;
    await assert.rejects(withFileMutex(file, async () => { entered += 1; }), { code: "ELOCKCLEANUP" });
    assert.equal(entered, 1);
    assert.equal((await fs.readdir(directory)).length, 1);
    await assert.rejects(withFileMutex(file, async () => assert.fail("admitted despite orphan")), { code: "ELOCKCLEANUP" });
    assert.equal((await fs.readdir(directory)).length, 1);
  } finally { fs.unlink = original; }
  await withFileMutex(file, async () => {});
  assert.deepEqual(await fs.readdir(directory), []);
});

test("multiple failed releases retain all same-PID orphans for recovery", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "mutex");
  const directory = `${await canonicalPath(file)}.mutex-v2`;
  let entered, finish;
  const ready = new Promise((resolve) => { entered = resolve; });
  const owner = withFileMutex(file, async () => {
    entered(); await new Promise((resolve) => { finish = resolve; });
  });
  const ownerResult = owner.catch((error) => error);
  t.after(async () => { finish?.(); await ownerResult; });
  await ready;
  const waiter = withFileMutex(file, async () => assert.fail("entered during release failure"), 5000);
  const waiterResult = waiter.catch((error) => error);
  const deadline = Date.now() + 5000;
  while ((await fs.readdir(directory)).filter((name) => name.endsWith(".json")).length !== 2) {
    assert.ok(Date.now() < deadline, "waiting caller did not publish its claim");
    await sleep(5);
  }
  const original = fs.unlink;
  fs.unlink = async (target) => {
    if (path.dirname(target) === directory && target.endsWith(".json")) {
      throw Object.assign(new Error("fixture concurrent release denied"), { code: "EACCES" });
    }
    return original(target);
  };
  try {
    finish();
    const errors = await Promise.all([ownerResult, waiterResult]);
    assert.deepEqual(errors.map((error) => error.code), ["ELOCKCLEANUP", "ELOCKCLEANUP"]);
    assert.equal((await fs.readdir(directory)).length, 2);
  } finally { fs.unlink = original; finish(); await Promise.all([ownerResult, waiterResult]); }
  await withFileMutex(file, async () => {}, 2000);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("invalid Guild keys cannot persist an unusable registry entry", async (t) => {
  const f = await fixture(t);
  for (const key of ["", "  ", null, 123]) {
    await assert.rejects(acquireResources([{ type: "guild", key }], f), /Invalid Guild key/);
  }
  await assert.rejects(fs.access(path.join(f.runtimeDir, "jobs")), { code: "ENOENT" });
  const release = await acquireResources([{ type: "guild", key: " fixture " }], f);
  await assert.rejects(acquireResources([{ type: "guild", key: "fixture" }], f), /使用中/);
  await release();
});

test("33-second stalled registry publication cannot grant two live writer leases", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const output = path.join(f.dir, "output");
  const owner = childWorker(t, { ...f, output }, `
const fs=require('node:fs/promises'),nativeFs=require('node:fs'),path=require('node:path');
const args=JSON.parse(process.argv[1]),original=fs.rename;
let stalled=false;
fs.rename=async(...values)=>{
 if(!stalled&&path.dirname(values[1])===path.join(args.runtimeDir,'jobs')){
  stalled=true;process.send({type:'stalled'});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,33000);
  nativeFs.renameSync(...values);return;
 }
 return original(...values);
};
(async()=>{
 const {acquireResources}=require(args.root+'/src/runtime-locks');
 const release=await acquireResources([{type:'path',path:args.output,mode:'write'}],args);
 process.send({type:'locked'});await new Promise(resolve=>process.once('message',resolve));
 await release();process.disconnect();
})().catch(e=>{process.send({type:'error',message:e.message});process.disconnect();});
`);
  await owner.wait("stalled");
  await assert.rejects(acquireResources([resource(output)], f), /使用中/);
  await owner.wait("locked");
  assert.equal((await fs.readdir(path.join(f.runtimeDir, "jobs"))).filter((name) => name.endsWith(".json")).length, 1);
  owner.child.send("release");
  assert.equal(await owner.exited, 0, owner.output());
  const release = await acquireResources([resource(output)], f);
  await release();
});
