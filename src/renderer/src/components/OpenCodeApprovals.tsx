import {useEffect,useRef,useState} from 'react'
import type {PendingApproval} from '../../../shared/types'
import {useApp} from '../state/AppContext'
import {playPostureRing as playChime} from '../lib/alertSound'
export function OpenCodeApprovals(){
  const {state,showToast}=useApp()
  const port=state.settings.openCodeApprovalPort
  const [rows,setRows]=useState<PendingApproval[]>([])
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [version,setVersion]=useState(0)
  const seen=useRef<Set<string>>(new Set())
  useEffect(()=>{
    let active=true
    let timer:ReturnType<typeof setTimeout>
    setRows([])
    async function refresh(){
      try{
        const result=await window.notch.approvals.list()
        if(!active)return
        // A request that was not on screen before deserves an alert, the same
        // way a finished turn does. The first sweep after opening is silent so
        // the panel does not chime for requests the user has already seen.
        const fresh=result.filter((row)=>!seen.current.has(row.fingerprint))
        if(fresh.length>0&&seen.current.size>0){
          if(state.settings.codingReplySound!==false)playChime()
          showToast(
            'OpenCode is waiting for you',
            `${fresh.length} approval request${fresh.length===1?'':'s'} waiting · Sessions`,
            'default'
          )
        }
        for(const row of result)seen.current.add(row.fingerprint)
        setRows(result);setError('')
      }
      catch{if(active){seen.current=new Set();setRows([]);setError('Could not read pending requests from OpenCode.')}}
      if(active)timer=setTimeout(refresh,3500)
    }
    if(port&&!busy)void refresh()
    return ()=>{active=false;clearTimeout(timer)}
  },[port,version,busy])
  async function decide(item:PendingApproval,reply:'once'|'reject'){
    setBusy(true)
    try{await window.notch.approvals.decide(item.fingerprint,reply,port!)}
    catch(e){showToast('OpenCode decision failed',String(e),'error')}
    finally{setBusy(false);setVersion(v=>v+1)}
  }
  if(!port)return null
  return <section><h3>OpenCode approvals</h3>{error&&<p role="alert">{error}</p>}
    {!error&&!rows.length&&<p>{busy?'Sending decision…':'Checking for pending requests'}</p>}
    {rows.map(item=><article key={item.fingerprint}><strong>Waiting for you · {item.operation}</strong><p>Session {item.session}</p>
    <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.details}</pre>
    <button disabled={busy} onClick={()=>void decide(item,'once')}>Approve once</button>
    <button disabled={busy} onClick={()=>void decide(item,'reject')}>Deny</button></article>)}</section>
}
