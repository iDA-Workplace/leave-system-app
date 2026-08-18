import { useEffect, useState } from 'react'
import { Button, Card, PageHeader } from '../components/ui'
import { useLanguage } from '../context/LanguageContext'
import { useToast } from '../context/ToastContext'
import {
  detectPlatform, isStandalone, canPromptInstall, onInstallPromptChange, promptInstall,
} from '../lib/pwa'
import './InstallGuide.css'

/**
 * 「怎麼把系統裝到手機／電腦」的圖文說明。
 *
 * 一頁列出全部三種裝置的步驟，只把「猜到的那一種」預設展開 —— 猜錯了使用者
 * 還是找得到自己那一段，總比只顯示一種、猜錯就無路可走要好。網址是 /install，
 * 可以直接貼到 Slack 給全公司。
 */

function Steps({ items }) {
  return (
    <ol className="install-steps">
      {items.map((text, i) => <li key={i}>{text}</li>)}
    </ol>
  )
}

function Platform({ id, title, here, open, onToggle, children }) {
  return (
    <Card className={`install-platform${open ? ' install-platform--open' : ''}`}>
      <button
        type="button"
        className="install-platform__head"
        aria-expanded={open}
        aria-controls={`install-body-${id}`}
        onClick={onToggle}
      >
        <span className="install-platform__title">
          {title}
          {here && <span className="install-platform__here">{here}</span>}
        </span>
        <span className="install-platform__chevron" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="install-platform__body" id={`install-body-${id}`}>{children}</div>}
    </Card>
  )
}

function InstallGuide() {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [platform] = useState(() => detectPlatform())
  const [open, setOpen] = useState(() => detectPlatform())
  const [promptable, setPromptable] = useState(canPromptInstall)

  // 安裝提示可能在這個頁面掛載之後才被瀏覽器丟出來，所以要訂閱而不是只讀一次。
  useEffect(() => onInstallPromptChange(() => setPromptable(canPromptInstall())), [])

  const installed = isStandalone()

  async function handleInstall() {
    const outcome = await promptInstall()
    if (outcome === 'accepted') showToast(t('install_done'))
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(window.location.origin)
      showToast(t('install_copied'))
    } catch {
      // 有些瀏覽器在非使用者手勢或不安全來源下會拒絕，那就把網址秀出來讓人自己複製
      showToast(window.location.origin)
    }
  }

  const toggle = id => setOpen(prev => (prev === id ? null : id))

  return (
    <div className="install-page">
      <PageHeader title={t('install_title')} />

      {installed ? (
        <Card className="install-banner install-banner--ok">{t('install_already')}</Card>
      ) : (
        <Card className="install-banner">
          <p className="install-banner__text">{t('install_intro')}</p>
          <div className="install-banner__actions">
            {promptable && <Button onClick={handleInstall}>{t('install_button')}</Button>}
            <Button variant="outlined" onClick={handleCopy}>{t('install_copy_url')}</Button>
          </div>
          <p className="install-url">{window.location.origin}</p>
        </Card>
      )}

      <Platform
        id="ios-safari"
        title={t('install_ios_title')}
        here={platform === 'ios-safari' ? t('install_your_device') : null}
        open={open === 'ios-safari'}
        onToggle={() => toggle('ios-safari')}
      >
        <Steps items={[t('install_ios_1'), t('install_ios_2'), t('install_ios_3'), t('install_ios_4')]} />
        <p className="install-note">{t('install_ios_note')}</p>
      </Platform>

      <Platform
        id="ios-other-browser"
        title={t('install_ios_other_title')}
        here={platform === 'ios-other-browser' ? t('install_your_device') : null}
        open={open === 'ios-other-browser'}
        onToggle={() => toggle('ios-other-browser')}
      >
        <p className="install-note">{t('install_ios_other_body')}</p>
        <Button variant="outlined" size="sm" onClick={handleCopy}>{t('install_copy_url')}</Button>
      </Platform>

      <Platform
        id="android"
        title={t('install_android_title')}
        here={platform === 'android' ? t('install_your_device') : null}
        open={open === 'android'}
        onToggle={() => toggle('android')}
      >
        <Steps items={[t('install_android_1'), t('install_android_2'), t('install_android_3')]} />
      </Platform>

      <Platform
        id="desktop"
        title={t('install_desktop_title')}
        here={platform === 'desktop' ? t('install_your_device') : null}
        open={open === 'desktop'}
        onToggle={() => toggle('desktop')}
      >
        <Steps items={[t('install_desktop_1'), t('install_desktop_2'), t('install_desktop_3')]} />
        <p className="install-note">{t('install_desktop_safari')}</p>
        <p className="install-note">{t('install_desktop_firefox')}</p>
      </Platform>

      <p className="install-footer">{t('install_footer')}</p>
    </div>
  )
}

export default InstallGuide
