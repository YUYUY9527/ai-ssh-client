import { beforeAll } from 'vitest';
import { useI18nStore } from '../src/renderer/i18n';

// 单元测试的统一语言环境：默认锁定简体中文，避免测试结果受运行机器系统语言影响。
// 应用运行时仍按「设置 > 跟随系统」自动选择语言。
beforeAll(() => {
  useI18nStore.setState({ locale: 'zh-CN' });
});
