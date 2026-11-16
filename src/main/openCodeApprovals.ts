import { createHash } from 'node:crypto'
import type { PendingApproval } from '../shared/types'

export function approvalClient(port:number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid OpenCode port.')
  const base = 'http://127.0.0.1:'+port
  async function request(path:string, body?:object) {
    const response=await fetch(base+path,{method:body?'POST':'GET', redirect:'error',
      headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(3500)})
    if(!response.ok) throw new Error('OpenCode returned '+response.status+'.')
    return response.json()
  }
  async function list():Promise<PendingApproval[]> {
    const rows:unknown=await request('/permission')
    if(!Array.isArray(rows))throw new Error('Unsupported OpenCode permission response.')
    return rows.map(row=>{
      if(typeof row?.id!=='string'||typeof row.sessionID!=='string'||typeof row.permission!=='string'||!Array.isArray(row.patterns))throw new Error('Unsupported OpenCode request.')
      return {id:row.id,session:row.sessionID,operation:row.permission,details:JSON.stringify({patterns:row.patterns,metadata:row.metadata},null,2),
        fingerprint:createHash('sha256').update(JSON.stringify(row)).digest('hex')}
    })
  }
  async function decide(fingerprint:string,reply:'once'|'reject') {
    if(reply!=='once'&&reply!=='reject')throw new Error('Invalid decision.')
    const pending=(await list()).find(row=>row.fingerprint===fingerprint)
    if(!pending)throw new Error('This request has changed or closed.')
    if(await request('/permission/'+encodeURIComponent(pending.id)+'/reply',{reply})!==true) throw new Error('OpenCode did not confirm the decision.')
  }
  return {list,decide}
}
