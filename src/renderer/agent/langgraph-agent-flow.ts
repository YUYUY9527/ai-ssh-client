import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';

import type { AgentResponse, Message } from '../../shared/types';
import type {
  AIChatResult,
  AIChatStreamEvent,
  AIChatStreamOptions,
  IPCResult,
} from '../../shared/ipc-types';

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type AnalyzeCommand = (command: string) => { riskLevel: RiskLevel };
type ParseAgentResponse = (content: string) => AgentResponse | null;
type ShouldBlockRepeatedCommand = (command: string) => boolean;
type NeedsApproval = (riskLevel: RiskLevel) => boolean;
type FallbackText = {
  parseRetry: string;
  cannotParse: string;
  invalidResponse: string;
  completed: string;
  analyzing: string;
  noCommand: string;
  duplicateCommand: (command: string) => string;
};

export type AgentGraphAction =
  | { type: 'execute'; response: AgentResponse; command: string }
  | { type: 'approval'; response: AgentResponse; command: string; riskLevel: RiskLevel }
  | { type: 'ask'; response: AgentResponse; question: string }
  | { type: 'finish'; response: AgentResponse; reason: string }
  | { type: 'retryParse'; message: string }
  | { type: 'fail'; reason: string; response?: AgentResponse };

type RequestCommandApprovalInput = {
  command: string;
  riskLevel: RiskLevel;
  response: AgentResponse;
};

type AskUserQuestionInput = {
  response: AgentResponse;
  question: string;
};

type InvokableTool<TInput, TOutput> = {
  invoke: (input: TInput) => Promise<TOutput>;
};

const requestCommandApprovalTool = tool(
  async (input: { command: string; riskLevel: RiskLevel; response: AgentResponse }) => ({
    type: 'approval' as const,
    response: input.response,
    command: input.command,
    riskLevel: input.riskLevel,
  }),
  {
    name: 'request_command_approval',
    description: 'Ask the user to approve a risky shell command before execution.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        response: { type: 'object' },
      },
      required: ['command', 'riskLevel', 'response'],
    },
  },
) as InvokableTool<RequestCommandApprovalInput, Extract<AgentGraphAction, { type: 'approval' }>>;

async function requestCommandApproval(
  input: RequestCommandApprovalInput,
): Promise<Extract<AgentGraphAction, { type: 'approval' }>> {
  return requestCommandApprovalTool.invoke(input);
}

const askUserQuestionTool = tool(
  async (input: { response: AgentResponse; question: string }) => ({
    type: 'ask' as const,
    response: input.response,
    question: input.question,
  }),
  {
    name: 'ask_user_question',
    description: 'Ask the user a question when the agent needs more information.',
    schema: {
      type: 'object',
      properties: {
        response: { type: 'object' },
        question: { type: 'string' },
      },
      required: ['response', 'question'],
    },
  },
) as InvokableTool<AskUserQuestionInput, Extract<AgentGraphAction, { type: 'ask' }>>;

async function askUserQuestion(
  input: AskUserQuestionInput,
): Promise<Extract<AgentGraphAction, { type: 'ask' }>> {
  return askUserQuestionTool.invoke(input);
}

const RoundGraphAnnotation = Annotation.Root({
  providerId: Annotation<string>(),
  messages: Annotation<Message[]>(),
  preparedMessages: Annotation<Message[]>(),
  requestId: Annotation<string>(),
  parseRetryAvailable: Annotation<boolean>(),
  aiChatStream: Annotation<AiChatStreamService>(),
  onStreamEvent: Annotation<((event: AIChatStreamEvent) => void) | undefined>(),
  parseResponse: Annotation<ParseAgentResponse>(),
  analyzeCommand: Annotation<AnalyzeCommand>(),
  shouldBlockRepeatedCommand: Annotation<ShouldBlockRepeatedCommand>(),
  needsApproval: Annotation<NeedsApproval>(),
  fallbackText: Annotation<FallbackText>(),
  beforeExecute: Annotation<((action: Extract<AgentGraphAction, { type: 'execute' }>) => void) | undefined>(),
  execute: Annotation<((command: string) => Promise<string>) | undefined>(),
  summarizeOutput: Annotation<((command: string, output: string) => string) | undefined>(),
  buildNextDecisionContext: Annotation<((command: string, output: string) => string) | undefined>(),
  rawContent: Annotation<string | undefined>(),
  response: Annotation<AgentResponse | null>(),
  nextAction: Annotation<AgentGraphAction | null>(),
  execution: Annotation<AgentExecutionGraphResult | undefined>(),
  error: Annotation<string | undefined>(),
});

type AiChatStreamService = (
  providerId: string,
  messages: Message[],
  options: AIChatStreamOptions,
) => Promise<IPCResult<AIChatResult>>;

interface RunAgentRoundGraphInput {
  providerId: string;
  messages: Message[];
  requestId: string;
  parseRetryAvailable: boolean;
  aiChatStream: AiChatStreamService;
  onStreamEvent?: (event: AIChatStreamEvent) => void;
  parseResponse: ParseAgentResponse;
  analyzeCommand: AnalyzeCommand;
  shouldBlockRepeatedCommand: ShouldBlockRepeatedCommand;
  needsApproval: NeedsApproval;
  fallbackText: FallbackText;
}

export interface AgentRoundGraphResult {
  rawContent?: string;
  response: AgentResponse | null;
  nextAction: AgentGraphAction;
  execution?: AgentExecutionGraphResult;
  error?: string;
}

const ExecutionGraphAnnotation = Annotation.Root({
  command: Annotation<string>(),
  output: Annotation<string | undefined>(),
  observation: Annotation<string | undefined>(),
  nextDecisionContext: Annotation<string | undefined>(),
  error: Annotation<string | undefined>(),
});

export interface AgentExecutionGraphResult {
  command: string;
  output: string;
  observation: string;
  nextDecisionContext: string;
  error?: string;
}

type AnyCompiledGraph = {
  invoke: (state: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

let roundGraph: AnyCompiledGraph | null = null;

export function estimateAgentMessagesTokens(messages: Message[]): number {
  return messages.reduce(
    (total, message) => total + Math.ceil(message.content.length / 4) + 4,
    0,
  );
}

/**
 * Runs a command execution through LangGraph.
 *
 * UI state updates intentionally stay in AgentRuntime; the graph owns the
 * execution transition and returns a plain result that can later be chained
 * into observation/decision nodes.
 */
export async function runAgentExecutionGraph(input: {
  command: string;
  execute: (command: string) => Promise<string>;
  summarizeOutput: (output: string) => string;
  buildNextDecisionContext: (command: string, output: string) => string;
}): Promise<AgentExecutionGraphResult> {
  const graph = new StateGraph(ExecutionGraphAnnotation)
    .addNode('executeCommand', async (state) => {
      try {
        return {
          output: await input.execute(state.command),
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
    .addNode('observeOutput', (state) => {
      if (state.error) {
        return {
          observation: state.error,
        };
      }

      return {
        observation: input.summarizeOutput(state.output || ''),
      };
    })
    .addNode('prepareNextDecisionContext', (state) => {
      if (state.error) {
        return {
          nextDecisionContext: state.error,
        };
      }

      return {
        nextDecisionContext: input.buildNextDecisionContext(
          state.command,
          state.output || '',
        ),
      };
    })
    .addEdge(START, 'executeCommand')
    .addEdge('executeCommand', 'observeOutput')
    .addEdge('observeOutput', 'prepareNextDecisionContext')
    .addEdge('prepareNextDecisionContext', END)
    .compile();

  const result = await graph.invoke({
    command: input.command,
    output: undefined,
    observation: undefined,
    nextDecisionContext: undefined,
    error: undefined,
  });

  return {
    command: result.command,
    output: result.output || '',
    observation: result.observation || '',
    nextDecisionContext: result.nextDecisionContext || '',
    error: result.error,
  };
}

/**
 * Runs one Agent round through LangGraph.
 *
 * This graph owns the orchestration shape for a full round: model call,
 * response parsing, action routing, optional command execution, and preparing
 * the next decision context. UI updates, approvals, and transport details stay
 * in AgentRuntime callbacks so the graph remains deterministic and testable.
 */
export async function runAgentRoundGraph(input: RunAgentRoundGraphInput & {
  beforeExecute?: (action: Extract<AgentGraphAction, { type: 'execute' }>) => void;
  execute: (command: string) => Promise<string>;
  summarizeOutput: (command: string, output: string) => string;
  buildNextDecisionContext: (command: string, output: string) => string;
}): Promise<AgentRoundGraphResult> {
  const graph = getRoundGraph();
  const result = await graph.invoke({
    ...input,
    preparedMessages: [],
    rawContent: undefined,
    response: null,
    nextAction: null,
    execution: undefined,
    error: undefined,
  });

  const nextAction = (result.nextAction as AgentGraphAction | null) || {
    type: 'fail',
    reason: input.fallbackText.cannotParse,
  };

  return {
    rawContent: result.rawContent as string | undefined,
    response: result.response as AgentResponse | null,
    nextAction,
    execution: result.execution as AgentExecutionGraphResult | undefined,
    error: result.error as string | undefined,
  };
}

function getRoundGraph(): AnyCompiledGraph {
  if (roundGraph) return roundGraph;

  roundGraph = new StateGraph(RoundGraphAnnotation)
    .addNode('prepareContext', (state) => ({
      preparedMessages: state.messages,
    }))
    .addNode('callModel', async (state) => {
      const result = await state.aiChatStream(state.providerId, state.preparedMessages, {
        requestId: state.requestId,
        onEvent: (event) => state.onStreamEvent?.(event),
      });

      if (!result.success || !result.data) {
        throw new Error(result.success ? 'AI response is empty' : result.error);
      }

      return {
        rawContent: result.data.content,
      };
    })
    .addNode('parseModelResponse', (state) => {
      if (!state.rawContent) {
        return {
          response: null,
        };
      }

      return {
        response: state.parseResponse(state.rawContent),
      };
    })
    .addNode('routeDecision', async (state) => {
      const response = state.response;
      if (!response) {
        return {
          nextAction: state.parseRetryAvailable
            ? { type: 'retryParse', message: state.fallbackText.parseRetry }
            : { type: 'fail', reason: state.fallbackText.invalidResponse },
        };
      }

      if (response.decision === 'finish') {
        return {
          nextAction: {
            type: 'finish',
            response,
            reason: response.finishReason || state.fallbackText.completed,
          },
        };
      }

      if (response.decision === 'ask') {
        return {
          nextAction: await askUserQuestion({
            response,
            question: response.question || state.fallbackText.analyzing,
          }),
        };
      }

      const command = response.command?.trim();
      if (!command) {
        return {
          nextAction: {
            type: 'fail',
            response,
            reason: state.fallbackText.noCommand,
          },
        };
      }

      if (state.shouldBlockRepeatedCommand(command)) {
        return {
          nextAction: {
            type: 'fail',
            response,
            reason: state.fallbackText.duplicateCommand(command),
          },
        };
      }

      const risk = state.analyzeCommand(command);
      if (state.needsApproval(risk.riskLevel)) {
        return {
          nextAction: await requestCommandApproval({
            response,
            command,
            riskLevel: risk.riskLevel,
          }),
        };
      }

      return {
        nextAction: {
          type: 'execute',
          response,
          command,
        },
      };
    })
    .addNode('executeAction', async (state) => {
      if (state.nextAction?.type !== 'execute') {
        return {};
      }

      const { command } = state.nextAction;
      try {
        state.beforeExecute?.(state.nextAction);
        const output = await state.execute?.(command);
        return {
          execution: {
            command,
            output: output || '',
            observation: state.summarizeOutput?.(command, output || '') || '',
            nextDecisionContext: state.buildNextDecisionContext?.(command, output || '') || '',
          },
        };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortedByRuntimeError') {
          throw error;
        }

        return {
          execution: {
            command,
            output: '',
            observation: error instanceof Error ? error.message : String(error),
            nextDecisionContext: error instanceof Error ? error.message : String(error),
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })
    .addEdge(START, 'prepareContext')
    .addEdge('prepareContext', 'callModel')
    .addEdge('callModel', 'parseModelResponse')
    .addEdge('parseModelResponse', 'routeDecision')
    .addEdge('routeDecision', 'executeAction')
    .addEdge('executeAction', END)
    .compile();

  return roundGraph;
}
