import type { Locale } from '../../ui/auth/messages'

export const sectorIds = ['garage','controle-technique','diagnostic-immobilier'] as const
export type SectorId = typeof sectorIds[number]
export type SectorPreset = Readonly<{label:string;faqQuestions:readonly string[];intakeQuestions:readonly string[]}>

const presets = {
  fr:{
    garage:{label:'Garage',faqQuestions:['Quelles prestations proposez-vous ?','Quels documents le client doit-il apporter ?'],intakeQuestions:['Quel véhicule est concerné ?','Quel est le motif de la demande ?']},
    'controle-technique':{label:'Contrôle technique',faqQuestions:['Quels véhicules prenez-vous en charge ?','Quels documents le client doit-il apporter ?'],intakeQuestions:['Quel type de véhicule est concerné ?','La demande concerne-t-elle un contrôle ou une contre-visite ?']},
    'diagnostic-immobilier':{label:'Diagnostic immobilier',faqQuestions:['Quels diagnostics proposez-vous ?','Quels documents le client doit-il préparer ?','Comment demande-t-on un devis ?'],intakeQuestions:['Quel type de bien est concerné ?','La demande concerne-t-elle une vente ou une location ?','Dans quelle commune se situe le bien ?']},
  },
  en:{
    garage:{label:'Garage',faqQuestions:['Which services do you offer?','Which documents should the customer bring?'],intakeQuestions:['Which vehicle is concerned?','What is the reason for the request?']},
    'controle-technique':{label:'Vehicle inspection',faqQuestions:['Which vehicles do you inspect?','Which documents should the customer bring?'],intakeQuestions:['What type of vehicle is concerned?','Is the request for an inspection or a retest?']},
    'diagnostic-immobilier':{label:'Property diagnostics',faqQuestions:['Which property diagnostics do you offer?','Which documents should the customer prepare?','How can a quote be requested?'],intakeQuestions:['What type of property is concerned?','Is the request for a sale or a rental?','In which town is the property located?']},
  },
} satisfies Record<Locale,Record<SectorId,SectorPreset>>
export function getSectorPreset(sector:SectorId,locale:Locale):SectorPreset{return presets[locale][sector]}
