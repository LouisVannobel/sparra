export type FollowUpFailure='conflict'|'provisional'|'unreadable'|'unknown'
export function followUpFailure(error:unknown):FollowUpFailure{
 if(error instanceof Response&&error.status===409){
  const code=error.headers.get('x-sparra-request-error')
  if(code==='publication-conflict')return 'conflict'
  if(code==='publication-provisional')return 'provisional'
  if(code==='publication-unreadable')return 'unreadable'
 }
 return 'unknown'
}
export const followUpMessages={
 fr:{unreadable:'Des pièces de la fiche sont illisibles. Actualisez après leur rétablissement pour pouvoir classer.',pending:'À traiter',all:'Tous les appels',views:'Vue des appels',revoke:'Remettre à traiter',firstDeclaration:'Première déclaration',provisional:'Collecte provisoire. Le classement sera disponible après sa clôture.',closed:'Collecte close',newPublication:'Nouveaux éléments à revoir',requests:'Demandes repérées',evidence:'Sources dans la conversation',audioCoverage:'Couverture de l’enregistrement inconnue.',callerPhone:'Numéro présenté par le téléphone',gaps:'Limites de la collecte',transcript_loss:'Des tours de conversation ont été perdus.',result_unavailable:'Le résultat de l’extraction est indisponible.',audio_partial:'L’enregistrement est partiel.',conflict:'La fiche a changé. Actualisez avant de déclarer son traitement.',unknown:'Résultat à vérifier. La réponse a pu être perdue après enregistrement. Actualisez pour relire l’état avant de réessayer.'},
 en:{unreadable:'Some published content cannot be read. Refresh after it is restored before classifying.',pending:'To treat',all:'All calls',views:'Call view',revoke:'Return to pending',firstDeclaration:'First declaration',provisional:'Collection is provisional. Classification will be available once it closes.',closed:'Collection closed',newPublication:'New information to review',requests:'Identified requests',evidence:'Sources in the conversation',audioCoverage:'Recording coverage is unknown.',callerPhone:'Number presented by the phone',gaps:'Collection limitations',transcript_loss:'Conversation turns were lost.',result_unavailable:'The extraction result is unavailable.',audio_partial:'The recording is partial.',conflict:'The call has changed. Refresh before declaring it treated.',unknown:'Result needs checking. The response may have been lost after saving. Refresh to read the current state before retrying.'},
} as const
