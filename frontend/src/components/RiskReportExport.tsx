import { DownloadSimple } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import type { RiskReportFormat } from '../domain'
import { useContour } from '../app/ContourProvider'
import { Button, InlineAlert, Modal } from '../shared/ui'

const formatOptions: Array<{ value: RiskReportFormat; label: string; hint: string }> = [
  { value: 'xlsx', label: 'Excel (.xlsx)', hint: 'Рекомендуется для анализа и передачи отчёта' },
  { value: 'csv_semicolon', label: 'CSV для русского Excel', hint: 'Разделитель: точка с запятой' },
  { value: 'csv_comma', label: 'CSV', hint: 'Разделитель: запятая' },
]

function asMoscowIso(date: string, endOfDay: boolean) {
  if (!date) return undefined
  return new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+03:00`).toISOString()
}

function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function RiskReportExport({ compact = false }: { compact?: boolean }) {
  const { currentUser, repository } = useContour()
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [format, setFormat] = useState<RiskReportFormat>('xlsx')
  const [validationError, setValidationError] = useState<string | null>(null)
  const exportMutation = useMutation({
    mutationFn: async () => {
      if (!repository.exportRiskReport) throw new Error('Выгрузка отчёта недоступна в текущем режиме')
      const fromIso = asMoscowIso(from, false)
      const toIso = asMoscowIso(to, true)
      if (fromIso && toIso && Date.parse(fromIso) > Date.parse(toIso)) {
        throw new Error('Дата начала периода не может быть позже даты окончания')
      }
      return repository.exportRiskReport({ from: fromIso, to: toIso, format })
    },
    onSuccess: (download) => {
      saveDownload(download.blob, download.filename)
      setOpen(false)
    },
  })

  if (!currentUser.permissions.includes('report.export') || !repository.exportRiskReport) return null

  const close = () => {
    if (exportMutation.isPending) return
    exportMutation.reset()
    setValidationError(null)
    setOpen(false)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setValidationError(null)
    if (from && to && from > to) {
      setValidationError('Дата начала периода не может быть позже даты окончания')
      return
    }
    exportMutation.mutate()
  }

  return (
    <>
      <Button
        variant="secondary"
        startIcon={<DownloadSimple size={18} />}
        aria-label={compact ? 'Выгрузить отчёт по рискам' : undefined}
        onClick={() => setOpen(true)}
      >
        {compact ? 'Отчёт' : 'Выгрузить отчёт'}
      </Button>
      <Modal
        open={open}
        onClose={close}
        title="Выгрузить отчёт по рискам"
        description="В отчёт попадут только объекты, доступные твоей учётной записи"
        closeOnBackdrop={!exportMutation.isPending}
        closeOnEscape={!exportMutation.isPending}
        footer={
          <div className="inline-actions" style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button variant="secondary" disabled={exportMutation.isPending} onClick={close}>Отмена</Button>
            <Button
              type="submit"
              form="risk-report-export-form"
              loading={exportMutation.isPending}
              startIcon={<DownloadSimple size={18} />}
            >
              Скачать
            </Button>
          </div>
        }
      >
        <form id="risk-report-export-form" className="form-grid" onSubmit={submit}>
          <div className="field">
            <label htmlFor="risk-report-from">С даты</label>
            <input id="risk-report-from" type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
            <p className="field__hint">Можно не указывать для выгрузки за всё время</p>
          </div>
          <div className="field">
            <label htmlFor="risk-report-to">По дату</label>
            <input id="risk-report-to" type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
            <p className="field__hint">Конечный день включается целиком</p>
          </div>
          <div className="field field--full">
            <label htmlFor="risk-report-format">Формат файла</label>
            <select id="risk-report-format" value={format} onChange={(event) => setFormat(event.target.value as RiskReportFormat)}>
              {formatOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <p className="field__hint">{formatOptions.find((option) => option.value === format)?.hint}</p>
          </div>
          {validationError ? (
            <InlineAlert className="field--full" tone="critical" title="Проверь период">{validationError}</InlineAlert>
          ) : null}
          {exportMutation.isError ? (
            <InlineAlert className="field--full" tone="critical" title="Не удалось выгрузить отчёт">
              {exportMutation.error instanceof Error ? exportMutation.error.message : 'Backend не сформировал файл'}
            </InlineAlert>
          ) : null}
        </form>
      </Modal>
    </>
  )
}
