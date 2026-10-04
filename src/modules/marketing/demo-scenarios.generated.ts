// Generated for the bounded presentation candidate; source is unchanged scenarios.fr.json.
export type DemoSectorId = 'garage' | 'controle-technique'
export interface DemoScenario {
  id: DemoSectorId
  label: string
  audioSrc: string
  durationSeconds: number
  cues: { speaker: 'sparra' | 'client'; text: string; startSeconds: number; endSeconds: number }[]
  receipt: { status: string; contact: string; phone: string; summary: string; nextAction: string }
}
export const demoScenarios: DemoScenario[] =[
  {
    "id": "garage",
    "label": "Garage",
    "audioSrc": "/demos/garage-revision.mp3",
    "durationSeconds": 35.432,
    "cues": [
      {
        "speaker": "sparra",
        "text": "Bonjour, vous êtes au Garage Horizon. Je suis Sparra, un agent IA. Quelle est votre demande ?",
        "startSeconds": 0.0,
        "endSeconds": 7.344
      },
      {
        "speaker": "client",
        "text": "Bonjour, je voudrais faire une révision de ma voiture.",
        "startSeconds": 7.694,
        "endSeconds": 12.878
      },
      {
        "speaker": "sparra",
        "text": "Je peux recueillir votre demande pour l'équipe. Quand préférez-vous être rappelé ?",
        "startSeconds": 13.228,
        "endSeconds": 17.74
      },
      {
        "speaker": "client",
        "text": "Demain matin, si possible. Je m'appelle Camille. Pour cet exemple, mon numéro est fictif.",
        "startSeconds": 18.09,
        "endSeconds": 24.81
      },
      {
        "speaker": "sparra",
        "text": "D'accord, votre préférence est un rappel demain matin pour une révision. L'équipe devra confirmer le rappel et les modalités. Aucun rendez-vous n'est confirmé.",
        "startSeconds": 25.16,
        "endSeconds": 35.432
      }
    ],
    "receipt": {
      "status": "Demande à traiter",
      "contact": "Camille — personne fictive",
      "phone": "Numéro fictif, non composé",
      "summary": "Demande de révision au Garage Horizon. Préférence de rappel : demain matin.",
      "nextAction": "Rappeler Camille et confirmer les modalités avec l’équipe. Aucun rendez-vous confirmé."
    }
  },
  {
    "id": "controle-technique",
    "label": "Contrôle technique",
    "audioSrc": "/demos/controle-technique.mp3",
    "durationSeconds": 38.816,
    "cues": [
      {
        "speaker": "sparra",
        "text": "Bonjour, vous êtes au Centre Clair. Je suis Sparra, un agent IA. Quelle est votre demande ?",
        "startSeconds": 0.0,
        "endSeconds": 6.744
      },
      {
        "speaker": "client",
        "text": "Bonjour, je souhaite une visite de contrôle technique pour ma voiture.",
        "startSeconds": 7.094,
        "endSeconds": 11.318
      },
      {
        "speaker": "sparra",
        "text": "Quelle est votre préférence pour cette visite ? L'équipe devra vérifier les disponibilités.",
        "startSeconds": 11.668,
        "endSeconds": 18.364
      },
      {
        "speaker": "client",
        "text": "Plutôt vendredi après-midi. Je m'appelle Alex. Pour cet exemple, mon numéro est fictif.",
        "startSeconds": 18.714,
        "endSeconds": 24.426
      },
      {
        "speaker": "sparra",
        "text": "Je retiens une demande de contrôle technique, avec une préférence pour vendredi après-midi. La date, le tarif et les modalités restent à confirmer avec l'équipe. Aucun rendez-vous n'est réservé.",
        "startSeconds": 24.776,
        "endSeconds": 38.816
      }
    ],
    "receipt": {
      "status": "Visite à confirmer",
      "contact": "Alex — personne fictive",
      "phone": "Numéro fictif, non composé",
      "summary": "Demande de visite de contrôle technique au Centre Clair. Préférence : vendredi après-midi.",
      "nextAction": "Contacter Alex pour confirmer les disponibilités et les modalités. Aucun rendez-vous réservé."
    }
  }
]
