import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Signed authorizations are bearer credentials. Store them locally, never in tool output.
export class PurchaseRecovery {
  constructor(directory, origin, fetchImpl=fetch) {
    this.directory=path.resolve(directory); this.origin=new URL(origin).origin;
    this.file=path.join(this.directory,'purchase.json'); this.fetch=fetchImpl;
    const url=new URL(origin);
    if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Use HTTPS for remote lounges.');
    this.lockFile=path.join(this.directory,'purchase.lock');
  }
  acquire() {
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    if(fs.lstatSync(this.directory).isSymbolicLink())throw new Error('Recovery directory must not be a symbolic link.');
    if(fs.existsSync(this.lockFile)) {
      const owner=JSON.parse(fs.readFileSync(this.lockFile,'utf8'));
      if(!Number.isInteger(owner.pid) || owner.pid<=0)throw new Error('Invalid recovery lock.');
      try {process.kill(owner.pid,0);throw new Error('Another client is using this recovery directory.');}
      catch(error) {if(error.code!=='ESRCH')throw error;fs.unlinkSync(this.lockFile);}
    }
    const fd=fs.openSync(this.lockFile,'wx',0o600); this.lockId=randomUUID();
    try {fs.writeFileSync(fd,JSON.stringify({pid:process.pid,id:this.lockId}));}finally{fs.closeSync(fd);}
  }
  release() {
    if(!this.lockId)return;
    try {if(JSON.parse(fs.readFileSync(this.lockFile,'utf8')).id===this.lockId)fs.unlinkSync(this.lockFile);}finally{this.lockId=null;}
  }
  read() {
    try {
      if(fs.lstatSync(this.file).isSymbolicLink()) throw new Error('Recovery file must not be a symbolic link.');
      const state=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(state.version!==1) throw new Error('Unsupported recovery file.');
      return state;
    } catch(error) {if(error.code==='ENOENT')return {version:1,pending:null,last:null};throw error;}
  }
  save(state) {
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    if(fs.lstatSync(this.directory).isSymbolicLink())throw new Error('Recovery directory must not be a symbolic link.');
    const tmp=path.join(this.directory,`purchase-${randomUUID()}.tmp`);
    const fd=fs.openSync(tmp,'wx',0o600);
    try {fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.renameSync(tmp,this.file);
    if(process.platform!=='win32'){const d=fs.openSync(this.directory,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
  }
  inspect() {
    const {pending,last}=this.read();
    return pending ? {pending:true,recoveryId:pending.id,estimatedUsd:pending.estimatedUsd,createdAt:pending.createdAt,
      note:'Retry reuses the original authorization. Do not create another purchase. Signed payment data remains local.'}
      : {pending:false,...(last?{recoveryId:last.id,result:last.result,receipt:last.receipt}:{} )};
  }
  validate(record) {
    const url=new URL(record.url);
    if(url.origin!==this.origin || url.username || url.password || !url.pathname.startsWith('/api/'))throw new Error('Recovery destination does not match this lounge.');
    if(!['GET','POST'].includes(record.method) || typeof record.payment!=='string')throw new Error('Invalid recovery request.');
  }
  async deliver(record, signal) {
    this.validate(record);
    const res=await this.fetch(record.url,{method:record.method,headers:{'Content-Type':'application/json','X-PAYMENT':record.payment},
      ...(record.body!==undefined?{body:record.body}:{}),signal,redirect:'error'});
    if(res.ok) {
      const result=await res.clone().json();
      this.save({version:1,pending:null,last:{id:record.id,result,receipt:res.headers.get('X-PAYMENT-RESPONSE') || res.headers.get('PAYMENT-RESPONSE')}});
    }
    return res;
  }
  async trackedFetch(input,init,estimatedUsd,onReserved=()=>{}) {
    const payment=new Headers(init?.headers).get('X-PAYMENT');
    if(!payment)return this.fetch(input,{...init,redirect:'error'});
    if(this.read().pending)throw new Error('Resolve the pending purchase before paying again.');
    const record={id:randomUUID(),url:String(input),method:init?.method || 'GET',body:init?.body,payment,estimatedUsd,createdAt:new Date().toISOString()};
    this.validate(record); this.save({version:1,pending:record,last:null});onReserved(record.id);
    return this.deliver(record,init?.signal);
  }
  async retry(beforeRetry,signal) {
    const {pending}=this.read();
    if(!pending)return null;
    this.validate(pending);beforeRetry(pending);
    return this.deliver(pending,signal);
  }
  closeExpired(acknowledgeLoss) {
    const state=this.read(),record=state.pending;if(!record)return this.inspect();
    if(acknowledgeLoss!==true)throw new Error('Explicitly acknowledge that an earlier payment may have settled and its result may be lost.');
    const auth=JSON.parse(Buffer.from(record.payment,'base64').toString('utf8')).payload?.authorization;
    const expiry=Number(auth?.validBefore);
    if(!Number.isSafeInteger(expiry) || expiry>=Math.floor(Date.now()/1000))throw new Error('The authorization has not expired. Retry recovery instead.');
    this.save({version:1,pending:null,last:{id:record.id,result:{closed:true,note:'No refund was issued. The original payment may have settled. This session budget reservation remains counted.'},receipt:null}});
    return this.inspect();
  }
}
