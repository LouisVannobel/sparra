import { useCallback,useState } from 'react'
import { useBlocker } from '@tanstack/react-router'
import type { Locale } from '../auth/messages'
import { activityMessages } from '../../modules/sparra/messages'
import type { ActivityNavigationState } from './activity-panel'
import type { CalendarNavigationState } from './calendar-panel'

const pristine={dirty:false,pending:false,reconcile:false}
export function useBusinessNavigation(locale:Locale){
  const [activity,setActivity]=useState<ActivityNavigationState>(pristine)
  const [calendar,setCalendar]=useState<CalendarNavigationState>({...pristine,connecting:false})
  const [connectionRefusal,setConnectionRefusal]=useState('')
  const onActivityNavigationStateChange=useCallback((next:ActivityNavigationState)=>setActivity(previous=>previous.dirty===next.dirty&&previous.pending===next.pending&&previous.reconcile===next.reconcile?previous:next),[])
  const onCalendarNavigationStateChange=useCallback((next:CalendarNavigationState)=>setCalendar(previous=>previous.dirty===next.dirty&&previous.pending===next.pending&&previous.reconcile===next.reconcile&&previous.connecting===next.connecting?previous:next),[])
  const risk=activity.dirty||activity.pending||activity.reconcile||calendar.dirty||calendar.pending||calendar.reconcile
  useBlocker({shouldBlockFn:()=>risk&&!window.confirm(activityMessages[locale].discardNavigation),disabled:!risk,enableBeforeUnload:risk})
  function onBeforeConnect(){
    if(activity.pending||activity.reconcile||calendar.pending||calendar.reconcile){setConnectionRefusal(activityMessages[locale].connectionNeedsResolution);return false}
    setConnectionRefusal('')
    return !risk||window.confirm(activityMessages[locale].discardNavigation)
  }
  return {onActivityNavigationStateChange,onCalendarNavigationStateChange,onBeforeConnect,externalNavigationPending:calendar.connecting,connectionRefusal}
}
