import { Schema } from 'effect'
import { calendarOfferLimits, calendarPolicySchema, type CalendarPolicy } from './policy'
import { validCalendarInstant } from './time'
export type CalendarInterval = { readonly start: string; readonly end: string }
type SearchInput={serviceId:string;windowStart:string;windowEnd:string;now:number;busy:readonly CalendarInterval[];/** Persisted intervals already include their reservation buffer. */holds?:readonly CalendarInterval[]}
function boundedCalendarWindow(policy:CalendarPolicy,input:SearchInput) {
  const service=policy.services.find(value=>value.id===input.serviceId)
  const start=Date.parse(input.windowStart),end=Date.parse(input.windowEnd)
  if(!service||!validCalendarInstant(input.windowStart)||!validCalendarInstant(input.windowEnd)||!Number.isFinite(input.now)||end<=start||end-start>calendarOfferLimits.horizonDays*86400000||end>input.now+calendarOfferLimits.horizonDays*86400000||input.busy.length>10000||(input.holds?.length??0)>1000)
    throw new Error('Invalid Calendar window')
  return {service,start,end}
}
function reservedCalendarIntervals(policy:CalendarPolicy,input:SearchInput) {
  function interval(value:CalendarInterval,bufferMinutes:number) {
    if(!validCalendarInstant(value.start)||!validCalendarInstant(value.end)||Date.parse(value.start)>=Date.parse(value.end))throw new Error('Invalid Calendar interval')
    return [Date.parse(value.start),Date.parse(value.end)+bufferMinutes*60000] as const
  }
  return [...input.busy.map(value=>interval(value,policy.bufferMinutes)),...(input.holds??[]).map(value=>interval(value,0))]
}
function localCalendarTime(format:Intl.DateTimeFormat,ms:number) {
  const p=Object.fromEntries(format.formatToParts(ms).map(part=>[part.type,part.value]))
  return {label:`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`,
    day:new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`).getUTCDay(),clock:`${p.hour}:${p.minute}`}
}
function calendarLabelCounts(format:Intl.DateTimeFormat,from:number,end:number,durationMinutes:number,bufferMinutes:number) {
  const step=calendarOfferLimits.stepMinutes*60000,labels=new Map<string,number>()
  const residues=new Set([0,durationMinutes%calendarOfferLimits.stepMinutes,(durationMinutes+bufferMinutes)%calendarOfferLimits.stepMinutes])
  for(let t=Math.floor((from-86400000)/step)*step;t<=end+86400000;t+=step)
    for(const residue of residues){const label=localCalendarTime(format,t+residue*60000).label;labels.set(label,(labels.get(label)??0)+1)}
  return labels
}
function acceptsCalendarCandidate(policy:CalendarPolicy,t:number,finish:number,reservedEnd:number,format:Intl.DateTimeFormat,labels:Map<string,number>,busy:readonly (readonly [number,number])[]) {
  const a=localCalendarTime(format,t),b=localCalendarTime(format,reservedEnd)
  if(labels.get(a.label)!==1||labels.get(localCalendarTime(format,finish).label)!==1||labels.get(b.label)!==1||a.label.slice(0,10)!==b.label.slice(0,10)||Date.parse(b.label+'Z')-Date.parse(a.label+'Z')!==reservedEnd-t)return false
  const ranges=policy.weeklyHours.find(value=>value.day===a.day)?.ranges??[]
  return ranges.some(range=>a.clock>=range.start&&b.clock<=range.end)&&!busy.some(([s,e])=>t<e&&reservedEnd>s)
}
export function findCalendarSlots(
  policy: CalendarPolicy,
  input: SearchInput,
): CalendarInterval[] {
  policy = Schema.decodeUnknownSync(calendarPolicySchema)(policy)
  const {service,start,end}=boundedCalendarWindow(policy,input)
  const busy=reservedCalendarIntervals(policy,input)
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: policy.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  // Candidate UTC instants make nonexistent labels impossible. Enumerating labels
  // across a padded bounded horizon also removes both sides of a repeated hour.
  const step = calendarOfferLimits.stepMinutes * 60000,
    from = Math.ceil(Math.max(start, input.now + policy.noticeMinutes * 60000) / step) * step
  const labels=calendarLabelCounts(format,from,end,service.durationMinutes,policy.bufferMinutes)
  const result: CalendarInterval[] = []
  for (let t = from; t + service.durationMinutes * 60000 <= end; t += step) {
    const finish=t+service.durationMinutes*60000,reservedEnd=finish+policy.bufferMinutes*60000
    if(!acceptsCalendarCandidate(policy,t,finish,reservedEnd,format,labels,busy))continue
    result.push({ start: new Date(t).toISOString(), end: new Date(finish).toISOString() })
    if (result.length === calendarOfferLimits.maximumOffers) break
  }
  return result
}
