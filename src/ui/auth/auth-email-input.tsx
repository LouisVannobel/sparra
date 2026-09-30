import { useId } from 'react'
import { Field } from '@astryxdesign/core/Field'
import { messages, type Locale } from './messages'

// Two auth consumers need HTML input purpose, absent from TextInput0.5.4.
export function AuthEmailInput({ locale, value, onChange, description, error, disabled = false }: {
  locale: Locale; value: string; onChange(value: string): void; description: string; error?: string; disabled?: boolean
}) {
  const id = useId(), descriptionID = id + '-description', messageID = id + '-error'
  return <Field label={messages[locale].email} inputID={id} description={description} descriptionID={descriptionID}
    isRequired isDisabled={disabled} width="100%" statusVariant="detached"
    status={error ? { type: 'error', message: error, messageID } : undefined}>
    <input className="auth-email-input" id={id} type="email" name="email" autoComplete="email" inputMode="email"
      value={value} onChange={event => onChange(event.currentTarget.value)} required disabled={disabled}
      aria-invalid={error ? true : undefined} aria-describedby={error ? `${descriptionID} ${messageID}` : descriptionID} />
  </Field>
}
