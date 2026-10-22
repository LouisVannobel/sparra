import { useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { TextArea } from '@astryxdesign/core/TextArea'
import { activityMessages } from '../../modules/sparra/messages'
import type { Locale } from '../auth/messages'

function appendWithinLimit(existing:string,addition:string,limit:number):string|null{
  const next=existing?`${existing}\n\n${addition}`:addition
  return next.replace(/\r\n/g,'\n').length<=limit?next:null
}
export function appendFaqAnswer(faq:string,question:string,answer:string):string|null{
  return question.trim()&&answer.trim()?appendWithinLimit(faq,`${question}\n${answer}`,3000):null
}
export function appendIntakeQuestion(instructions:string,question:string):string|null{
  return question.trim()?appendWithinLimit(instructions,question,2000):null
}

type HelperProps={locale:Locale;questions:readonly string[];disabled:boolean;onChange(next:string):void}
export function ActivityFaqHelper({locale,faq,questions,disabled,onChange,onPreparedAnswersChange}:HelperProps&{faq:string;onPreparedAnswersChange?:(value:boolean)=>void}){
  const t=activityMessages[locale]
  // Answers retain their question identity, including when the owner changes sector.
  const [question,setQuestion]=useState<string|null>(null),[answers,setAnswers]=useState<Record<string,string>>({})
  const hasPreparedAnswers=Object.values(answers).some(value=>value.length>0)
  useEffect(()=>{onPreparedAnswersChange?.(hasPreparedAnswers)},[hasPreparedAnswers,onPreparedAnswersChange])
  const answer=question===null?'':answers[question]??''
  const next=question===null?null:appendFaqAnswer(faq,question,answer)
  return <div className="sparra-knowledge-helper"><h2>{t.ownerAnswers}</h2><p className="sparra-form-hint">{t.faqQuestionsHint}</p>
    <div className="sparra-helper-choices">{questions.map(value=><Button key={value} type="button" label={value} aria-pressed={question===value} isDisabled={disabled} onClick={()=>setQuestion(value)}/>)}</div>
    {question!==null&&<div className="sparra-helper-answer"><p>{question}</p>{!questions.includes(question)&&<p className="sparra-form-hint">{t.previousQuestion}</p>}
      <TextArea label={t.ownerAnswer} value={answer} onChange={value=>setAnswers(previous=>({...previous,[question]:value}))} rows={3} isDisabled={disabled} width="100%"/>
      {answer.trim()&&next===null&&<p role="alert">{t.helperFaqFull}</p>}
      <Button type="button" label={t.addOwnerAnswer} isDisabled={disabled||next===null} onClick={()=>{if(next!==null){onChange(next);setAnswers(previous=>({...previous,[question]:''}))}}}/>
    </div>}
  </div>
}
export function ActivityIntakeHelper({locale,instructions,questions,disabled,onChange}:HelperProps&{instructions:string}){
  const t=activityMessages[locale]
  return <div className="sparra-knowledge-helper"><h2>{t.callerInformation}</h2><p className="sparra-form-hint">{t.intakeQuestionsHint}</p>
    <ul className="sparra-helper-intake">{questions.map(question=>{const next=appendIntakeQuestion(instructions,question);return <li key={question}><span>{question}</span><Button type="button" label={t.addCallerQuestion} aria-label={`${t.addCallerQuestion} : ${question}`} isDisabled={disabled||next===null} onClick={()=>{if(next!==null)onChange(next)}}/></li>})}</ul>
    {questions.some(question=>appendIntakeQuestion(instructions,question)===null)&&<p role="alert">{t.helperInstructionsFull}</p>}
  </div>
}
