import { create } from 'zustand'

/** 引导页视图：选择入口 / 图文教程 */
export type OnboardingView = 'choice' | 'guide'

/** 新手引导弹窗的开合与当前视图 */
export const useOnboarding = create(() => ({
  open: false,
  view: 'choice' as OnboardingView,
}))

export const openOnboarding = (view: OnboardingView = 'choice') =>
  useOnboarding.setState({ open: true, view })

export const closeOnboarding = () => useOnboarding.setState({ open: false })
