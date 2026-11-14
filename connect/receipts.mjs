const STATUS=new Set(['succeeded','failed','unknown']);
export function createReceipt({operation,adapter='unknown',result={},observedAt=new Date().toISOString(),evidence=[]}){
  const ok=result?.ok===true;const status=ok?'succeeded':result?.ok===false?'failed':'unknown';
  return {operation,adapter,status,observed_at:observedAt,evidence:Array.isArray(evidence)?evidence.slice(0,20):[],detail:ok?String(result.text??'').slice(0,500):String(result.error??'unknown').slice(0,240)};
}
export function validateReceipt(receipt){return Boolean(receipt&&typeof receipt.operation==='string'&&STATUS.has(receipt.status)&&typeof receipt.adapter==='string'&&typeof receipt.observed_at==='string'&&Array.isArray(receipt.evidence));}
