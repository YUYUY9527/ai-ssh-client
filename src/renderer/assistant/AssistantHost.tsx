import { lazy, Suspense, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useI18n } from '../i18n';
import { useAgentStore } from '../store/useAgentStore';

const AgentPet = lazy(async () => {
  const module = await import('../components/AgentPet');
  return { default: module.AgentPet };
});
const AgentExecutor = lazy(async () => {
  const module = await import('../components/AgentExecutor');
  return { default: module.AgentExecutor };
});

interface AssistantHostProps {
  isHome: boolean;
  focusInputToken: number;
  input: string;
  isOpen: boolean;
  onInputChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
}

/** Hosts the assistant surface without owning workspace/session lifecycle. */
export function AssistantHost({
  isHome,
  focusInputToken,
  input,
  isOpen,
  onInputChange,
  onOpenChange,
  onOpenSettings,
}: AssistantHostProps) {
  const { t } = useI18n();
  const [hasBeenOpened, setHasBeenOpened] = useState(false);
  const currentTask = useAgentStore((state) => state.currentTask);
  const shouldRunAgentExecutor = Boolean(
    currentTask && currentTask.state !== 'finished' && currentTask.state !== 'error',
  );

  useEffect(() => {
    if (isOpen) setHasBeenOpened(true);
  }, [isOpen]);

  const launcher = (
    <button
      type="button"
      className={`agent-pet-button agent-pet-launcher${isHome && !isOpen ? ' agent-pet-button-home' : ''}`}
      aria-label={t('agent.title')}
      aria-expanded={isOpen}
      onClick={() => onOpenChange(true)}
    >
      <Sparkles className="h-5 w-5" />
    </button>
  );

  if (!hasBeenOpened && !isOpen) {
    return shouldRunAgentExecutor ? (
      <>
        {launcher}
        <Suspense fallback={null}>
          <AgentExecutor />
        </Suspense>
      </>
    ) : launcher;
  }

  return (
    <>
      {shouldRunAgentExecutor && (
        <Suspense fallback={null}>
          <AgentExecutor />
        </Suspense>
      )}
      <Suspense fallback={launcher}>
        <AgentPet
          input={input}
          onInputChange={onInputChange}
          focusInputToken={focusInputToken}
          isOpen={isOpen}
          isHome={isHome}
          onOpenChange={onOpenChange}
          onOpenSettings={onOpenSettings}
        />
      </Suspense>
    </>
  );
}
