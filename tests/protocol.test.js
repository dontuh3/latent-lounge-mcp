import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('real MCP stdio, free onboarding, and HTTP errors require no wallet', async t => {
  const api = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/menu') return res.end(JSON.stringify({ network: 'base', pricing: { play: '.02' } }));
    if (req.url === '/api/sample/sequence?client=mcp&wallet=no&found=other') return res.end(JSON.stringify({ puzzleId: 'free-test' }));
    res.writeHead(429, { 'Retry-After': '60' }).end(JSON.stringify({ error: 'slow down' }));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lounge-mcp-test-'));
  const messages = [
    {id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'0'}}},
    {method:'notifications/initialized'}, {id:2,method:'tools/list'},
    ...['lounge_readiness','lounge_sample','lounge_tournament','lounge_spend_status'].map((name,i)=>({id:i+3,method:'tools/call',params:{name,arguments:name==='lounge_sample'?{game:'sequence'}:{}}}))
  ];
  const input = path.join(dir,'input'), output = path.join(dir,'output'), errors = path.join(dir,'errors');
  fs.writeFileSync(input,messages.map(m=>JSON.stringify({jsonrpc:'2.0',...m})).join('\n')+'\n');
  const fds=[fs.openSync(input,'r'),fs.openSync(output,'w'),fs.openSync(errors,'w')];
  const child=spawn(process.execPath,['index.js'],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:fds,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,PRIVATE_KEY:'',DESIGNATION:'',MAX_SPEND_USD:'1',LOUNGE_URL:`http://127.0.0.1:${api.address().port}`}});
  fds.forEach(fd=>fs.closeSync(fd));
  t.after(async()=>{child.kill();if(child.exitCode===null)await once(child,'exit');api.closeAllConnections();await new Promise(r=>api.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const read=()=>fs.readFileSync(output,'utf8').trim().split('\n').filter(Boolean).flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});
  const until=Date.now()+15000;while(read().length<6&&Date.now()<until&&child.exitCode===null)await new Promise(r=>setTimeout(r,25));
  const responses=read();assert.equal(responses.length,6,fs.readFileSync(errors,'utf8'));
  const result=id=>responses.find(r=>r.id===id).result;
  const body=id=>JSON.parse(result(id).content[0].text);
  assert.equal(result(2).tools.length,22);
  assert.equal(body(3).walletConfigured,false);assert.equal(body(3).balanceChecked,false);assert.equal(body(3).designation,null);
  assert.equal(body(4).puzzleId,'free-test');
  assert.equal(result(5).isError,true);assert.equal(body(5).httpStatus,429);assert.equal(body(5).retryAfter,'60');
  assert.equal(body(6).spentUsd,0);
});
