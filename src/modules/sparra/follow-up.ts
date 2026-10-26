export type RequestFollowUp = Readonly<{
  publicationRevision: number
  decisionToken: string
  reviewedRevision: number
  declarationActive: boolean
  collectionClosed: boolean
  contentReadable: boolean
  firstDeclaredAt: string | null
}>
export type UpdateRequestFollowUpInput = Readonly<{
  requestId: string
  expectedPublicationRevision: number
  expectedDecisionToken: string
  treated: boolean
}>
export type RequestFollowUpReceipt = Readonly<{ requestId: string; followUp: RequestFollowUp }>
export const requiresReview = (followUp: RequestFollowUp) => !followUp.declarationActive || followUp.reviewedRevision < followUp.publicationRevision
