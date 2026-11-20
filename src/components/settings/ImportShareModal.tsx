import { useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { importSharedChat, ShareImportError } from '../../services/chat/shareImport.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

type ScreenLock = { release: () => Promise<void> }

/** 导入期间让屏幕保持常亮（手机不自动锁屏），不支持时静默降级 */
const keepScreenAwake = async (): Promise<ScreenLock | null> => {
  try {
    const wakeLock = (
      navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<ScreenLock> }
      }
    ).wakeLock
    return wakeLock ? await wakeLock.request('screen') : null
  } catch {
    return null
  }
}

/** 导入期间拦截误关/刷新页面 */
const guardUnload = (event: BeforeUnloadEvent) => {
  event.preventDefault()
  event.returnValue = ''
}

/** 导入 DeepSeek 分享对话：粘贴链接 → 抓取并转换为本地会话，成功后自动打开 */
export const ImportShareModal = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const importing = useRef(false)

  const submit = async () => {
    if (importing.current || busy) {
      return
    }
    importing.current = true
    setBusy(true)
    setError(null)
    const screenLock = await keepScreenAwake()
    window.addEventListener('beforeunload', guardUnload)
    try {
      await importSharedChat(link)
      showToast({ key: 'shareImportSuccess' })
      onClose()
    } catch (cause) {
      const key: TranslationKey = cause instanceof ShareImportError ? cause.key : 'shareImportFailed'
      const detail = cause instanceof ShareImportError ? cause.detail : undefined
      setError(detail ? `${t(key)}（${detail}）` : t(key))
    } finally {
      window.removeEventListener('beforeunload', guardUnload)
      void screenLock?.release().catch(() => {})
      importing.current = false
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('importShareTitle')}
      onClose={() => {
        if (!busy) {
          onClose()
        }
      }}
      footer={
        <>
          <Button variant="outlined" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || link.trim() === ''}
            onClick={() => void submit()}
          >
            {busy ? t('shareImporting') : t('importShareAction')}
          </Button>
        </>
      }
    >
      <div className={styles.apiKeyInput}>
        <input
          value={link}
          placeholder={t('importSharePlaceholder')}
          disabled={busy}
          autoFocus
          spellCheck={false}
          onChange={(event) => setLink(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void submit()
            }
          }}
        />
      </div>
      {busy ? <div className={styles.shareImportHint}>{t('shareImportKeepOpen')}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
    </Modal>
  )
}
