import { create } from 'zustand';
import type { 
  AgentMode, 
  AgentState, 
  ThinkingStep, 
  AgentExecution, 
  AgentTask, 
  AgentConfig,
  AppSettings,
  PendingApproval
} from '../../shared/types';

interface AgentStore {
  // 模式状态
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;

  // 智能体状态
  agentState: AgentState;
  setAgentState: (state: AgentState) => void;

  // 当前任务
  currentTask: AgentTask | null;
  setCurrentTask: (task: AgentTask | null) => void;

  // 配置
  config: AgentConfig;
  updateConfig: (config: Partial<AgentConfig>) => void;
  syncFromSettings: (settings: AppSettings) => void;

  // 等待审批的命令
  pendingApproval: PendingApproval | null;
  setPendingApproval: (approval: PendingApproval | null, resetResult?: boolean) => void;

  // 审批结果：'approved' | 'rejected' | null
  approvalResult: 'approved' | 'rejected' | null;
  setApprovalResult: (result: 'approved' | 'rejected' | null) => void;

  // 等待用户回答的问题
  pendingQuestion: string | null;
  setPendingQuestion: (question: string | null) => void;

  // 用户对 pendingQuestion 的回答
  pendingInput: string | null;
  setPendingInput: (input: string | null) => void;

  // 终端等待用户交互输入
  pendingTerminalPrompt: string | null;
  setPendingTerminalPrompt: (prompt: string | null) => void;

  // 任务历史
  taskHistory: AgentTask[];
  addTaskToHistory: (task: AgentTask) => void;
  clearTaskHistory: () => void;

  // 思考步骤操作
  addThinkingStep: (step: ThinkingStep) => void;
  updateThinkingStep: (stepId: string, updates: Partial<ThinkingStep>) => void;

  // 执行记录操作
  addExecution: (execution: AgentExecution) => void;

  // 任务操作
  startTask: (userInput: string) => AgentTask;
  completeTask: (success: boolean, error?: string, finishReason?: string) => void;
  pauseTask: () => void;
  resumeTask: () => void;
  cancelTask: () => void;

  // 上下文裁剪
  trimAgentContext: () => void;

  // 重置
  reset: () => void;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  // 模式状态
  mode: 'agent',
  setMode: (mode) => set({ mode }),

  // 智能体状态
  agentState: 'idle',
  setAgentState: (state) => set({ agentState: state }),

  // 当前任务
  currentTask: null,
  setCurrentTask: (task) => set({ currentTask: task }),

  // 默认配置
  config: {
    enabled: true,
    autoExecute: true,
    maxExecutionSteps: 20,
    requireApprovalForRisk: true,
    approveHighRisk: true,
    approveMediumRisk: true,
    // 上下文管理配置
    maxContextMessages: 20,
    trimContextEnabled: true,
    maxTerminalOutputLength: 8000,
    // 任务上下文联动
    taskContextRounds: 3,
  },
  updateConfig: (config) => set((state) => ({ 
    config: { ...state.config, ...config } 
  })),

  syncFromSettings: (settings: AppSettings) => set((state) => ({
    config: {
      ...state.config,
      enabled: settings.agentEnabled ?? true,
      autoExecute: settings.agentAutoExecute ?? true,
      requireApprovalForRisk: true,
      approveHighRisk: settings.approveHighRisk ?? true,
      approveMediumRisk: settings.approveMediumRisk ?? true,
      maxExecutionSteps: settings.agentMaxExecutionSteps ?? 20,
      maxContextMessages: settings.agentMaxContextMessages ?? 20,
      maxTerminalOutputLength: settings.agentMaxTerminalOutputLength ?? 8000,
      trimContextEnabled: settings.agentTrimContextEnabled ?? true,
      taskContextRounds: settings.agentTaskContextRounds ?? 3,
    },
  })),

  // 等待审批
  pendingApproval: null,
  setPendingApproval: (approval, resetResult = false) => set((state) => ({
    pendingApproval: approval,
    // 只有在 resetResult 为 true 时才重置 approvalResult
    ...(resetResult ? { approvalResult: null } : {})
  })),

  // 审批结果
  approvalResult: null,
  setApprovalResult: (result) => set({ approvalResult: result }),

  // 等待用户回答的问题
  pendingQuestion: null,
  setPendingQuestion: (question) => set({ pendingQuestion: question }),

  // 用户对 pendingQuestion 的回答
  pendingInput: null,
  setPendingInput: (input) => set({ pendingInput: input }),

  // 终端交互等待
  pendingTerminalPrompt: null,
  setPendingTerminalPrompt: (prompt) => set({ pendingTerminalPrompt: prompt }),

  // 任务历史
  taskHistory: [],
  addTaskToHistory: (task) => set((state) => ({
    taskHistory: [task, ...state.taskHistory].slice(0, 50)
  })),
  clearTaskHistory: () => set({ taskHistory: [] }),

  // 添加思考步骤
  addThinkingStep: (step) => set((state) => {
    if (!state.currentTask) return state;
    return {
      currentTask: {
        ...state.currentTask,
        thinkingSteps: [...state.currentTask.thinkingSteps, step]
      }
    };
  }),

  // 更新思考步骤
  updateThinkingStep: (stepId, updates) => set((state) => {
    if (!state.currentTask) return state;
    return {
      currentTask: {
        ...state.currentTask,
        thinkingSteps: state.currentTask.thinkingSteps.map(step =>
          step.id === stepId ? { ...step, ...updates } : step
        )
      }
    };
  }),

  // 添加执行记录
  addExecution: (execution) => set((state) => {
    if (!state.currentTask) return state;
    return {
      currentTask: {
        ...state.currentTask,
        executions: [...state.currentTask.executions, execution]
      }
    };
  }),

  // 开始任务
  startTask: (userInput) => {
    const task: AgentTask = {
      id: Date.now().toString(),
      userInput,
      state: 'thinking',
      thinkingSteps: [],
      executions: [],
      startTime: Date.now(),
    };
    set({ currentTask: task, agentState: 'thinking' });
    return task;
  },

  // 完成任务
  completeTask: (success, error, finishReason) => set((state) => {
    if (!state.currentTask) return state;

    const normalizedError = typeof error === 'string' ? error : error == null ? undefined : String(error);
    const normalizedFinishReason = typeof finishReason === 'string'
      ? finishReason
      : finishReason == null
        ? undefined
        : String(finishReason);

    const completedTask: AgentTask = {
      ...state.currentTask,
      state: success ? 'finished' : 'error',
      endTime: Date.now(),
      error: success ? undefined : normalizedError,
      finishReason: normalizedFinishReason,
    };

    // 添加到历史
    const newHistory = [completedTask, ...state.taskHistory].slice(0, 50);

    return {
      currentTask: completedTask,
      agentState: success ? 'finished' : 'error',
      taskHistory: newHistory,
    };
  }),

  // 暂停任务
  pauseTask: () => set((state) => {
    if (!state.currentTask || state.currentTask.state === 'paused') return state;
    return {
      agentState: 'paused',
      currentTask: {
        ...state.currentTask,
        state: 'paused'
      }
    };
  }),

  // 继续任务
  resumeTask: () => set((state) => {
    if (!state.currentTask || state.currentTask.state !== 'paused') return state;
    return {
      agentState: 'thinking',
      currentTask: {
        ...state.currentTask,
        state: 'thinking'
      }
    };
  }),

  // 取消任务（保留内容，显示取消状态）
  cancelTask: () => set((state) => {
    if (!state.currentTask) return state;
    return {
      agentState: 'finished',
      currentTask: {
        ...state.currentTask,
        state: 'finished',
        endTime: Date.now(),
        finishReason: '用户已取消任务',
      },
      pendingApproval: null,
      pendingQuestion: null,
      pendingInput: null,
      pendingTerminalPrompt: null,
      approvalResult: null,
    };
  }),

  // 上下文裁剪（用于 agentMessagesRef）
  trimAgentContext: () => {
    // 注意：这个方法主要是给 AgentExecutor 调用的
    // 由于 agentMessagesRef 是在组件内部的 ref，我们需要在 AgentExecutor 中处理
    console.log('[Agent 上下文] 建议裁剪上下文');
  },

  // 重置
  reset: () => set({
    currentTask: null,
    agentState: 'idle',
    pendingApproval: null,
    pendingQuestion: null,
    pendingInput: null,
    pendingTerminalPrompt: null,
    approvalResult: null,
  }),
}));
