import logoUrl from '../../assets/logo.png'
import { useTranslate } from '../../i18n/index.js'
import { setOnboarded } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeOnboarding, useOnboarding } from './onboardingState.js'
import styles from './Onboarding.module.css'

const guideSteps = [
  { title: 'onboardingStep1Title', desc: 'onboardingStep1Desc' },
  { title: 'onboardingStep2Title', desc: 'onboardingStep2Desc' },
  { title: 'onboardingStep3Title', desc: 'onboardingStep3Desc' },
] as const

/** 关闭引导并记住已完成，之后不再自动弹出 */
const finish = () => {
  setOnboarded()
  closeOnboarding()
}

/** 记录完成并打开设置的数据管理分组，直接填写 API Key */
const finishToSettings = () => {
  finish()
  openSettings('data')
}

/** 首次访问引导：选择「已有 Key 直接用」或「查看图文教程」 */
export const OnboardingDialog = () => {
  const open = useOnboarding((state) => state.open)
  const view = useOnboarding((state) => state.view)
  const t = useTranslate()
  if (!open) {
    return null
  }
  return (
    <Modal
      title={
        <div className={styles.titleRow}>
          <img className={styles.titleLogo} src={logoUrl} alt="" draggable={false} />
          {t(view === 'guide' ? 'onboardingGuideTitle' : 'onboardingTitle')}
        </div>
      }
      closable
      onClose={finish}
      footer={
        view === 'guide' ? (
          <>
            <Button
              variant="outlined"
              size="m"
              onClick={() => useOnboarding.setState({ view: 'choice' })}
            >
              {t('onboardingBack')}
            </Button>
            <Button size="m" onClick={finishToSettings}>
              {t('onboardingGoSettings')}
            </Button>
          </>
        ) : (
          <button type="button" className={styles.skip} onClick={finish}>
            {t('onboardingSkip')}
          </button>
        )
      }
    >
      {view === 'guide' ? (
        <>
          <ol className={styles.steps}>
            {guideSteps.map((step) => (
              <li key={step.title} className={styles.step}>
                <div className={styles.stepTitle}>{t(step.title)}</div>
                <div className={styles.stepDesc}>{t(step.desc)}</div>
              </li>
            ))}
          </ol>
          <a
            className={styles.platform}
            href="https://platform.deepseek.com"
            target="_blank"
            rel="noreferrer"
          >
            {t('onboardingOpenPlatform')}
          </a>
        </>
      ) : (
        <>
          <div className={styles.intro}>{t('onboardingIntro')}</div>
          <div className={styles.options}>
            <button type="button" className={styles.option} onClick={finishToSettings}>
              <div className={styles.optionTitle}>{t('onboardingHaveKey')}</div>
              <div className={styles.optionHint}>{t('onboardingHaveKeyHint')}</div>
            </button>
            <button
              type="button"
              className={styles.option}
              onClick={() => useOnboarding.setState({ view: 'guide' })}
            >
              <div className={styles.optionTitle}>{t('onboardingNeedHelp')}</div>
              <div className={styles.optionHint}>{t('onboardingNeedHelpHint')}</div>
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

export { closeOnboarding }
