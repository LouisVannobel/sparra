import { useEffect, useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { demoScenarios } from '../../modules/marketing/demo-scenarios.generated'
import { currentCueIndex } from '../../modules/marketing/demo-cue'

function timeLabel(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function SparraDemo(): React.JSX.Element {
  const [scenario, setScenario] = useState(demoScenarios[0]!)
  const [playing, setPlaying] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState(false)
  const [interactive, setInteractive] = useState(false)
  const audio = useRef<HTMLAudioElement>(null)
  const attempt = useRef(0)
  const cue = currentCueIndex(scenario, seconds)

  useEffect(() => {
    const captured = audio.current
    setInteractive(captured !== null)
    return () => {
      attempt.current++
      captured?.pause()
    }
  }, [scenario.id])

  function stop(): void {
    // Invalidate before pause: its pending play promise can reject asynchronously.
    attempt.current++
    audio.current?.pause()
    setPlaying(false)
  }

  function select(value: string): void {
    const next = demoScenarios.find(item => item.id === value)
    if (!next || next.id === scenario.id) return
    stop()
    if (audio.current) audio.current.currentTime = 0
    setSeconds(0)
    setError(false)
    setScenario(next)
  }

  function toggle(): void {
    if (playing) { stop(); return }
    const media = audio.current
    if (!media) return
    const requested = ++attempt.current
    if (media.error !== null) {
      media.load()
      setSeconds(0)
    }
    setError(false)
    setPlaying(true)
    void media.play().then(() => {
      if (attempt.current === requested && audio.current === media) setPlaying(!media.paused)
    }, () => {
      if (attempt.current !== requested || audio.current !== media) return
      // Even AbortError is a real failure unless this attempt was canceled here.
      setPlaying(false)
      setError(true)
    })
  }

  function restart(): void {
    stop()
    if (audio.current) audio.current.currentTime = 0
    setSeconds(0)
  }

  return <section id="demo" className="sparra-demo sparra-section sparra-width" aria-labelledby="sparra-demo-title">
    <div className="sparra-section-heading">
      <h2 id="sparra-demo-title">Un appel, des deux côtés.</h2>
      <p>Exemple enregistré — scénario fictif</p>
      <p className="sparra-example-label">Exemple illustratif : écoutez la conversation et découvrez la fiche que l’entreprise peut recevoir.</p>
    </div>
    <div className="sparra-demo-window">
    <div className="sparra-demo-toolbar"><span className="sparra-demo-wordmark">sparra<span aria-hidden="true">.</span></span><span className="sparra-demo-caption">Exemple enregistré · scénario fictif</span></div>
    <div className="sparra-demo-body">
    <SegmentedControl className="sparra-sectors" label="Métier de l’exemple" value={scenario.id} onChange={select} layout="fill" isDisabled={!interactive}>
      {demoScenarios.map(item => <SegmentedControlItem key={item.id} value={item.id} label={item.label} />)}
    </SegmentedControl>
    <div className="sparra-demo-pair">
      <div className="sparra-conversation">
        <h3>Ce que votre client entend</h3>
        <audio key={scenario.id} ref={audio} src={scenario.audioSrc} preload="metadata"
          onTimeUpdate={event => { if (event.currentTarget === audio.current) setSeconds(event.currentTarget.currentTime) }}
          onPause={event => { if (event.currentTarget === audio.current) setPlaying(false) }}
          onEnded={event => { if (event.currentTarget === audio.current) setPlaying(false) }}
          onError={event => {
            if (event.currentTarget !== audio.current) return
            attempt.current++
            setPlaying(false)
            setError(true)
          }} />
        <div className="sparra-player-actions">
          <Button className="sparra-contact" label={playing ? 'Pause' : 'Écouter l’exemple'} onClick={toggle} variant="primary" isDisabled={!interactive} />
          <Button label="Recommencer" onClick={restart} variant="secondary" isDisabled={!interactive} />
        </div>
        <div className="sparra-progress">
          <progress aria-label="Progression de l’exemple" value={seconds} max={scenario.durationSeconds} />
          <span>{timeLabel(seconds)} / {timeLabel(scenario.durationSeconds)}</span>
        </div>
        {error && <p role="alert" className="sparra-audio-error">L’audio ne peut pas être lu. Réessayez avec « Écouter l’exemple » ; la transcription et la fiche restent disponibles.</p>}
        <ol className="sparra-transcript" aria-label={`Transcription — ${scenario.label}`}>
          {scenario.cues.map((turn, index) => <li key={index} data-speaker={turn.speaker} aria-current={cue === index ? 'true' : undefined}>
            <span className="sparra-speaker">{turn.speaker === 'sparra' ? 'Sparra · agent IA' : 'Client'}</span>
            <p>{turn.text}</p>
          </li>)}
        </ol>
      </div>
      <aside className="sparra-receipt" aria-labelledby="sparra-receipt-title">
        <h3 id="sparra-receipt-title">Ce que vous recevez</h3>
        <p className="sparra-example-label">Fiche illustrative — aucune demande réelle envoyée.</p>
        <p className="sparra-status"><Icon icon="clock" size="sm" aria-hidden="true" focusable="false" /> {scenario.receipt.status}</p>
        <dl>
          <div><dt>À faire</dt><dd>{scenario.receipt.nextAction}</dd></div>
          <div><dt>Contact</dt><dd>{scenario.receipt.contact}</dd></div>
          <div><dt>Téléphone</dt><dd>{scenario.receipt.phone}</dd></div>
          <div><dt>Demande</dt><dd>{scenario.receipt.summary}</dd></div>
        </dl>
      </aside>
    </div>
    </div>
    </div>
  </section>
}
