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

const MAX_AGENT_HISTORY_TASKS = 30;
const MAX_HISTORY_STEP_CONTENT = 1600;
const MAX_HISTORY_EXECUTION_OUTPUT = 2000;

function truncateHistoryText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...`;
}

function compactAgentTaskForHistory(task: AgentTask): AgentTask {
  return {
    ...task,
    thinkingSteps: task.thinkingSteps.map((step) => ({
      ...step,
      content: truncateHistoryText(step.content, MAX_HISTORY_STEP_CONTENT),
    })),
    executions: task.executions.map((execution) => ({
      ...execution,
      output: truncateHistoryText(execution.output, MAX_HISTORY_EXECUTION_OUTPUT),
    })),
  };
}

function persistAgentTask(task: AgentTask): void {
  if (typeof window === 'undefined') return;
  void window.electronAPI?.saveAgentTaskHistory?.(compactAgentTaskForHistory(task));
}

function createConversationId(): string {
  return `conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeAgentTask(task: AgentTask): AgentTask {
  return compactAgentTaskForHistory({
    ...task,
    conversationId: task.conversationId || task.id,
  });
}

interface AgentStore {
  // 濠电姷顣藉Σ鍛村垂椤忓牆鐒垫い鎺嗗亾缁剧虎鍘惧☉鐢稿焵椤掑嫭鈷戠紓浣癸供閻掗箖鏌涢埡鍌滃⒌闁糕斁鍋?
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;

  // 闂傚倷绀侀幖顐﹀箠濡偐纾芥慨妯挎硾缁€鍌涗繆椤栨粎甯涘┑顖涙尦閺岀喖骞戦幇顓犮€愮紒妤佸灴濮?
  agentState: AgentState;
  setAgentState: (state: AgentState) => void;

  // 闂佽崵鍠愮划搴㈡櫠濡ゅ懎绠伴柛娑橈攻濞呯娀鏌ｅΟ铏癸紞妞も晝鍏橀幃褰掑炊閵娿儳绁峰?
  currentTask: AgentTask | null;
  setCurrentTask: (task: AgentTask | null) => void;
  activeConversationId: string;
  startNewConversation: () => void;
  selectConversation: (conversationId: string) => void;

  // 闂傚倸鍊烽悞锕€顭垮Ο鑲╃煋闁割偅娲橀崑?
  config: AgentConfig;
  updateConfig: (config: Partial<AgentConfig>) => void;
  syncFromSettings: (settings: AppSettings) => void;

  // 缂傚倸鍊烽悞锔剧矙閹次诲洭顢涘鍕靛仺闂佺粯妫侀妴鈧柛瀣崌瀹曟寰勬繝鍌楁嫟濠电姰鍨奸～澶屾暜閿熺姴绠氶柛鎰靛枛缁€瀣亜閹板墎鍒版繛鍫涘劜缁?
  pendingApproval: PendingApproval | null;
  setPendingApproval: (approval: PendingApproval | null, resetResult?: boolean) => void;

  // 闂備浇顕ф鎼佸储濠婂牆绀堟繝闈涙川閻濆爼鏌熼悜妯烩拻缁炬儳銈搁弻鐔煎箚瑜滈崵鐔访瑰搴＄仸闁?approved' | 'rejected' | null
  approvalResult: 'approved' | 'rejected' | null;
  setApprovalResult: (result: 'approved' | 'rejected' | null) => void;

  // 缂傚倸鍊烽悞锔剧矙閹次诲洭顢涘鍕靛仺闂佺粯鏌ㄩ崥瀣磻閵娾晜鐓忓┑鐘茬箳閻ｉ亶鏌ｉ幘瀛樼闁哄本鐩俊鐤槻濞寸姍鍥ㄧ厽闁挎稑瀚弸娑㈡煙椤栨艾鏆ｇ€规洜鍠栭、娑樷槈瀹曞洦銇濇繝?
  pendingQuestion: string | null;
  setPendingQuestion: (question: string | null) => void;

  // 闂傚倷鐒﹀鍨焽閸ф绀夌€广儱顦弰銉︾箾閹寸偛鐒归柛?pendingQuestion 闂傚倷鐒﹂惇褰掑礉瀹€鈧埀顒佸嚬閸撴瑧鍙呴梺鍝勭▉閸嬪棙銇?
  pendingInput: string | null;
  setPendingInput: (input: string | null) => void;

  // 缂傚倸鍊搁崐椋庣矆娓氣偓閹嗙疀濞戣鲸鏅滃銈嗗笒閸婄粯銇欓崘宸唵閻犺櫣灏ㄩ崝鐔虹磼閹板墎绡€闁哄矉缍侀敐鐐侯敆閳ь剚淇婃禒瀣厱闁冲搫鍊婚埊鏇犵磼閸屾氨效濠碘€崇埣瀹曠喖顢橀姀鈶╁亾濞差亝鐓涘璺猴功婢ф盯鏌熼崨濠冨€愮€?
  pendingTerminalPrompt: string | null;
  setPendingTerminalPrompt: (prompt: string | null) => void;

  // 婵犵數鍋涢顓熸叏妤ｅ喚鏁嬬憸搴ㄥ箞閵娾晜鍋勯柣鎾抽閸嬪秹姊虹化鏇炲⒉妞ゃ劌鎳橀幏?
  taskHistory: AgentTask[];
  addTaskToHistory: (task: AgentTask) => void;
  clearTaskHistory: () => void;
  setTaskHistory: (tasks: AgentTask[]) => void;
  removeTaskFromHistory: (taskId: string) => void;

  // 闂傚倷娴囬鏍礈濮樿鲸宕查柛鈩冪☉閻掑灚銇勯幒鍡椾壕闂佸摜鍣ラ崹鍫曘€佸Δ鍛€烽柟纰卞幗椤旀棃姊洪棃娑氬婵☆偅鐟╅獮鍡椻枎瀵?
  addThinkingStep: (step: ThinkingStep) => void;
  updateThinkingStep: (stepId: string, updates: Partial<ThinkingStep>) => void;

  // 闂傚倷绀佸﹢閬嶆偡閹惰棄骞㈤柍鍝勫€归弶鎼佹⒑閼姐倕小闁绘帪绠戦…鍨熼懖鈺冾槸閻庡箍鍎遍ˇ顖滅不閼测斁鍋撻獮鍨姎閻庢凹鍠氱划?
  addExecution: (execution: AgentExecution) => void;

  // 婵犵數鍋涢顓熸叏妤ｅ喚鏁嬬憸搴ㄥ箞閵娾晜鍋勯柣鎾虫捣椤旀捇鎮楅獮鍨姎閻庢凹鍠氱划?
  startTask: (userInput: string) => AgentTask;
  completeTask: (success: boolean, error?: string, finishReason?: string) => void;
  pauseTask: () => void;
  resumeTask: () => void;
  cancelTask: () => void;

  // 闂傚倸鍊烽悞锕併亹閸愵亞鐭撻柛顐ｆ礃閸?
  reset: () => void;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  // 濠电姷顣藉Σ鍛村垂椤忓牆鐒垫い鎺嗗亾缁剧虎鍘惧☉鐢稿焵椤掑嫭鈷戠紓浣癸供閻掗箖鏌涢埡鍌滃⒌闁糕斁鍋?
  mode: 'agent',
  setMode: (mode) => set({ mode }),

  // 闂傚倷绀侀幖顐﹀箠濡偐纾芥慨妯挎硾缁€鍌涗繆椤栨粎甯涘┑顖涙尦閺岀喖骞戦幇顓犮€愮紒妤佸灴濮?
  agentState: 'idle',
  setAgentState: (state) => set({ agentState: state }),

  // 闂佽崵鍠愮划搴㈡櫠濡ゅ懎绠伴柛娑橈攻濞呯娀鏌ｅΟ铏癸紞妞も晝鍏橀幃褰掑炊閵娿儳绁峰?
  currentTask: null,
  setCurrentTask: (task) => set({ currentTask: task }),
  activeConversationId: createConversationId(),
  startNewConversation: () => set({
    activeConversationId: createConversationId(),
    currentTask: null,
    agentState: 'idle',
    pendingApproval: null,
    pendingQuestion: null,
    pendingInput: null,
    pendingTerminalPrompt: null,
    approvalResult: null,
  }),
  selectConversation: (conversationId) => set({
    activeConversationId: conversationId,
    currentTask: null,
    agentState: 'idle',
    pendingApproval: null,
    pendingQuestion: null,
    pendingInput: null,
    pendingTerminalPrompt: null,
    approvalResult: null,
  }),

  // 婵犳鍠楃敮妤冪矙閹烘せ鈧箓宕奸妷顔芥櫍婵犵數濮电喊宥夋偂閳ь剟鎮楅獮鍨姎婵炲眰鍔戝?
  config: {
    enabled: true,
    semanticSummaryContextLength: 12000,
    requireApprovalForRisk: true,
    approveHighRisk: true,
    approveMediumRisk: true,
  },
  updateConfig: (config) => set((state) => ({ 
    config: { ...state.config, ...config } 
  })),

  syncFromSettings: (settings: AppSettings) => set((state) => ({
    config: {
      ...state.config,
      enabled: settings.agentEnabled ?? true,
      requireApprovalForRisk: true,
      approveHighRisk: settings.approveHighRisk ?? true,
      approveMediumRisk: settings.approveMediumRisk ?? true,
      semanticSummaryContextLength: settings.agentSemanticSummaryContextLength ?? 12000,
    },
  })),

  // 缂傚倸鍊烽悞锔剧矙閹次诲洭顢涘鍕靛仺闂佺粯妫侀妴鈧柛瀣崌瀹曟寰勬繝鍌楁嫟濠?
  pendingApproval: null,
  setPendingApproval: (approval, resetResult = false) => set((state) => ({
    pendingApproval: approval,
    // 闂傚倷绀侀幉锟犳偡椤栨稓顩叉繝闈涙４閼板灝銆掑锝呬壕閻?resetResult 婵?true 闂傚倷绀侀幖顐﹀疮閹惰棄鏄ラ柡宥冨妽濞呯娀鏌ｅΟ鑲╁笡闁绘挸鍊婚埀顒€绠嶉崕鍗灻洪妸鈺佸嚑?approvalResult
    ...(resetResult ? { approvalResult: null } : {})
  })),

  // 闂備浇顕ф鎼佸储濠婂牆绀堟繝闈涙川閻濆爼鏌熼悜妯烩拻缁炬儳銈搁弻鐔煎箚瑜滈崵鐔访?
  approvalResult: null,
  setApprovalResult: (result) => set({ approvalResult: result }),

  // 缂傚倸鍊烽悞锔剧矙閹次诲洭顢涘鍕靛仺闂佺粯鏌ㄩ崥瀣磻閵娾晜鐓忓┑鐘茬箳閻ｉ亶鏌ｉ幘瀛樼闁哄本鐩俊鐤槻濞寸姍鍥ㄧ厽闁挎稑瀚弸娑㈡煙椤栨艾鏆ｇ€规洜鍠栭、娑樷槈瀹曞洦銇濇繝?
  pendingQuestion: null,
  setPendingQuestion: (question) => set({ pendingQuestion: question }),

  // 闂傚倷鐒﹀鍨焽閸ф绀夌€广儱顦弰銉︾箾閹寸偛鐒归柛?pendingQuestion 闂傚倷鐒﹂惇褰掑礉瀹€鈧埀顒佸嚬閸撴瑧鍙呴梺鍝勭▉閸嬪棙銇?
  pendingInput: null,
  setPendingInput: (input) => set({ pendingInput: input }),

  // 缂傚倸鍊搁崐椋庣矆娓氣偓閹嗙疀濞戣鲸鏅滃銈嗗笂閼冲爼銆呴弻銉︾厪闁割偅绻傞顐︽⒒婢跺﹦肖缂佽鲸甯掗埥澶婎潨閸℃锔剧磽?
  pendingTerminalPrompt: null,
  setPendingTerminalPrompt: (prompt) => set({ pendingTerminalPrompt: prompt }),

  // 婵犵數鍋涢顓熸叏妤ｅ喚鏁嬬憸搴ㄥ箞閵娾晜鍋勯柣鎾抽閸嬪秹姊虹化鏇炲⒉妞ゃ劌鎳橀幏?
  taskHistory: [],
  addTaskToHistory: (task) => set((state) => ({
    taskHistory: [normalizeAgentTask(task), ...state.taskHistory].slice(0, MAX_AGENT_HISTORY_TASKS)
  })),
  clearTaskHistory: () => set({ taskHistory: [] }),
  setTaskHistory: (tasks) => set({
    taskHistory: tasks.map(normalizeAgentTask).slice(0, MAX_AGENT_HISTORY_TASKS),
  }),
  removeTaskFromHistory: (taskId) => set((state) => ({
    taskHistory: state.taskHistory.filter((task) => task.id !== taskId),
  })),

  // 濠电姷鏁搁崕鎴犵礊閳ь剚銇勯弴鍡楀閸欏繘鏌ｉ幇顒佹儓缂佺姵鍨剁换婵嬫濞淬儱鐗撳畷鎴﹀箻鐠囪尙顦ㄩ梺鍐叉惈閿曘倖淇婃潏銊ょ箚?
  addThinkingStep: (step) => set((state) => {
    if (!state.currentTask) return state;
    return {
      currentTask: {
        ...state.currentTask,
        thinkingSteps: [...state.currentTask.thinkingSteps, step]
      }
    };
  }),

  // 闂傚倷绀侀幖顐⒚洪妶澶嬪仱闁靛ň鏅涢拑鐔封攽閻樺弶鎼愮紒鐘冲灦缁绘繈妫冨ù銉ョ墦瀹曟垿骞樼拠鑼槰闂佸啿鎼敃銈嗕繆鏉堛劋绻?
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

  // 濠电姷鏁搁崕鎴犵礊閳ь剚銇勯弴鍡楀閸欏繘鏌ｉ幇顒佹儓缂佺姰鍎抽幉鎼佸箣閿旇　鍋撴笟鈧獮瀣偐閸愬樊鈧盯姊洪崫鍕垫Ъ婵炲娲滅划?
  addExecution: (execution) => set((state) => {
    if (!state.currentTask) return state;
    return {
      currentTask: {
        ...state.currentTask,
        executions: [...state.currentTask.executions, execution]
      }
    };
  }),

  // 闂佽瀛╅鏍窗閹烘纾婚柟鐐灱閺€鑺ャ亜閺冨倵鎷￠柛搴￠叄閺岀喖鐛崹顔句紙閻?
  startTask: (userInput) => {
    const conversationId = get().activeConversationId || createConversationId();
    const task: AgentTask = {
      id: Date.now().toString(),
      conversationId,
      userInput,
      state: 'thinking',
      thinkingSteps: [],
      executions: [],
      startTime: Date.now(),
    };
    set({ activeConversationId: conversationId, currentTask: task, agentState: 'thinking' });
    return task;
  },

  // 闂備浇顕уù鐑藉箠閹捐瀚夋い鎺戝閸ㄥ倹鎱ㄥ鍡楀箻妞も晝鍏橀幃褰掑炊閵娿儳绁峰?
  completeTask: (success, error, finishReason) => set((state) => {
    if (!state.currentTask) return state;

    const normalizedError = typeof error === 'string' ? error : error == null ? undefined : String(error);
    const normalizedFinishReason = typeof finishReason === 'string'
      ? finishReason
      : finishReason == null
        ? undefined
        : String(finishReason);

    const completedTask: AgentTask = normalizeAgentTask({
      ...state.currentTask,
      state: success ? 'finished' : 'error',
      endTime: Date.now(),
      error: success ? undefined : normalizedError,
      finishReason: normalizedFinishReason,
    });

    // 濠电姷鏁搁崕鎴犵礊閳ь剚銇勯弴鍡楀閸欏繘鏌ｉ幇顒佹儓缂佲偓閸℃稒鐓涘璺猴功娴犮垽鏌涜閿曨亪寮?
    const newHistory = [
      completedTask,
      ...state.taskHistory.filter((task) => task.id !== completedTask.id),
    ].slice(0, MAX_AGENT_HISTORY_TASKS);
    persistAgentTask(completedTask);

    return {
      currentTask: completedTask,
      agentState: success ? 'finished' : 'error',
      taskHistory: newHistory,
    };
  }),

  // 闂傚倷绀侀幖顐⑽涘Δ鍛９闁告稑锕﹂々鐑芥煟濡櫣锛嶆い鈺冨厴閹綊宕堕妸銉хシ濡?
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

  // 缂傚倸鍊搁崐椋庣礊閳ь剟鏌涘☉鍗炵仭闁哄棛澧楃换娑氣偓鐢殿焾闉嬪銈嗘肠閸曨剙寮?
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

  // Preserve current task content and mark it as cancelled.
  cancelTask: () => set((state) => {
    if (!state.currentTask) return state;
    const cancelledTask: AgentTask = normalizeAgentTask({
      ...state.currentTask,
      state: 'finished',
      endTime: Date.now(),
      finishReason: 'Task cancelled by user',
    });
    persistAgentTask(cancelledTask);

    return {
      agentState: 'finished',
      currentTask: cancelledTask,
      taskHistory: [
        cancelledTask,
        ...state.taskHistory.filter((task) => task.id !== cancelledTask.id),
      ].slice(0, MAX_AGENT_HISTORY_TASKS),
      pendingApproval: null,
      pendingQuestion: null,
      pendingInput: null,
      pendingTerminalPrompt: null,
      approvalResult: null,
    };
  }),

  // Reset runtime state.
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
