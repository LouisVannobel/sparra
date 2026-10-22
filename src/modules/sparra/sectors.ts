import type { Locale } from '../../ui/auth/messages'

export const sectorIds = ['garage','controle-technique'] as const
export type SectorId = typeof sectorIds[number]
export type SectorPreset = Readonly<{label:string;faqQuestions:readonly string[];intakeQuestions:readonly string[]}>

const presets = {
  fr:{
    garage:{label:'Garage',faqQuestions:['Quelles prestations proposez-vous ?','Quels documents le client doit-il apporter ?'],intakeQuestions:['Quel véhicule est concerné ?','Quel est le motif de la demande ?']},
    'controle-technique':{label:'Contrôle technique',faqQuestions:['Quels véhicules prenez-vous en charge ?','Quels documents le client doit-il apporter ?'],intakeQuestions:['Quel type de véhicule est concerné ?','La demande concerne-t-elle un contrôle ou une contre-visite ?']},
  },
  en:{
    garage:{label:'Garage',faqQuestions:['Which services do you offer?','Which documents should the customer bring?'],intakeQuestions:['Which vehicle is concerned?','What is the reason for the request?']},
    'controle-technique':{label:'Vehicle inspection',faqQuestions:['Which vehicles do you inspect?','Which documents should the customer bring?'],intakeQuestions:['What type of vehicle is concerned?','Is the request for an inspection or a retest?']},
  },
} satisfies Record<Locale,Record<SectorId,SectorPreset>>
export function getSectorPreset(sector:SectorId,locale:Locale):SectorPreset{return presets[locale][sector]}
