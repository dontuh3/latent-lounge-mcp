import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PurchaseRecovery } from '../purchase-recovery.js';
import { wrapFetchWithPayment } from 'x402-fetch';
import { privateKeyToAccount } from 'viem/accounts';
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lounge-recovery-'));t.after(()=>{const target=fs.realpathSync(dir),parent=fs.realpathSync(os.tmpdir());if(path.dirname(target)===parent&&path.basename(target).startsWith('lounge-recovery-'))fs.rmSync(target,{recursive:true,force:true});});return dir;}
const signed=expiry=>Buffer.from(JSON.stringify({payload:{authorization:{validBefore:String(expiry)}}})).toString('base64');
test('separate clients cannot write the same recovery directory concurrently',t=>{
 const dir=directory(t),a=new PurchaseRecovery(dir,'https://example.com'),b=new PurchaseRecovery(dir,'https://example.com');
 a.acquire();assert.throws(()=>b.acquire(),/Another client/);a.release();b.acquire();b.release();
});
test('a lost response persists its original authorization and survives a new client instance',async t=>{
 const dir=directory(t),calls=[],payment=signed(Math.floor(Date.now()/1000)+600);
 const send=async(url,init)=>{calls.push({url,init});if(calls.length===1)throw new Error('lost response');return new Response(JSON.stringify({paid:true,puzzleId:'same-purchase'}),{headers:{'X-PAYMENT-RESPONSE':'receipt'}});};
 const first=new PurchaseRecovery(dir,'https://example.com',send);
 await assert.rejects(first.trackedFetch('https://example.com/api/play/walk',{method:'GET',headers:{'X-PAYMENT':payment}},0.02),/lost/);
 assert.equal(first.inspect().pending,true);assert.equal(JSON.stringify(first.inspect()).includes(payment),false);
 const restarted=new PurchaseRecovery(dir,'https://example.com',send);let reservations=0;
 await restarted.retry(()=>reservations++);assert.equal(reservations,1);
 assert.equal(calls[0].init.headers['X-PAYMENT'],calls[1].init.headers['X-PAYMENT']);
 assert.equal(restarted.inspect().pending,false);assert.equal(restarted.inspect().result.puzzleId,'same-purchase');
 assert.equal(fs.readFileSync(restarted.file,'utf8').includes(payment),false);
});
test('pending payments refuse replacement and cannot be redirected to another origin',async t=>{
 const dir=directory(t),payment=signed(Math.floor(Date.now()/1000)+600);
 const r=new PurchaseRecovery(dir,'https://example.com',async()=>new Response('{}',{status:503}));
 await r.trackedFetch('https://example.com/api/play/walk',{headers:{'X-PAYMENT':payment}},0.02);
 await assert.rejects(r.trackedFetch('https://example.com/api/play/cipher',{headers:{'X-PAYMENT':payment}},0.02),/pending/);
 const other=new PurchaseRecovery(dir,'https://other.example',()=>{throw new Error('must not send');});
 await assert.rejects(other.retry(()=>{}),/destination/);
 assert.throws(()=>r.closeExpired(true),/not expired/);
});
test('expired records require explicit loss acknowledgement and free fetches write no files',async t=>{
 const dir=directory(t),r=new PurchaseRecovery(dir,'https://example.com',async()=>new Response('{}',{status:402}));
 await r.trackedFetch('https://example.com/api/menu',{},0);assert.equal(fs.existsSync(r.file),false);
 await r.trackedFetch('https://example.com/api/play/walk',{headers:{'X-PAYMENT':signed(1)}},0.02);
 assert.throws(()=>r.closeExpired(false),/acknowledge/);assert.equal(r.closeExpired(true).pending,false);
});

test('real x402 wrapper checkpoints its signed request and refuses an excessive quote',async t=>{
 const dir=directory(t),url='https://example.com/api/play/walk',headers=[];
 const quote={x402Version:1,accepts:[{scheme:'exact',network:'base',maxAmountRequired:'20000',resource:url,description:'test',mimeType:'application/json',payTo:'0x'+'2'.repeat(40),maxTimeoutSeconds:60,asset:'0x'+'3'.repeat(40),extra:{name:'USD Coin',version:'2'}}]};
 const mock=async(input,init)=>{
  const payment=new Headers(init?.headers).get('X-PAYMENT');
  if(!payment)return new Response(JSON.stringify(quote),{status:402});
  headers.push(payment);if(headers.length===1)throw new Error('lost signed response');
  return new Response(JSON.stringify({paid:true,puzzleId:'recovered'}),{headers:{'X-PAYMENT-RESPONSE':'mock-receipt'}});
 };
 const recovery=new PurchaseRecovery(dir,url,mock),account=privateKeyToAccount('0x'+'1'.repeat(64));
 const guarded=wrapFetchWithPayment((u,i)=>recovery.trackedFetch(u,i,0.02),account,20000n);
 await assert.rejects(guarded(url,{method:'GET'}),/lost signed/);
 assert.equal(recovery.inspect().pending,true);
 await recovery.retry(()=>{});assert.equal(headers[0],headers[1]);assert.equal(recovery.inspect().result.puzzleId,'recovered');
 const tooSmall=wrapFetchWithPayment(mock,account,10000n);
 await assert.rejects(tooSmall(url),/exceeds maximum/);assert.equal(headers.length,2);
});
