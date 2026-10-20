import { createFileRoute } from '@tanstack/react-router'
import { requestResources } from '../platform/resources.server'
import { calendarCallbackResponse } from '../modules/calendar/calendar-http.server'
export const Route=createFileRoute('/api/calendar/google/callback')({server:{handlers:{GET:({request})=>calendarCallbackResponse(request,requestResources(request))}}})
