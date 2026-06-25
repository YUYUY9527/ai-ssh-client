import { AgentPet } from '../components/AgentPet';

interface AssistantHostProps {
  focusInputToken: number;
  input: string;
  isOpen: boolean;
  onInputChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
}

/** Hosts the assistant surface without owning workspace/session lifecycle. */
export function AssistantHost({
  focusInputToken,
  input,
  isOpen,
  onInputChange,
  onOpenChange,
  onOpenSettings,
}: AssistantHostProps) {
  return (
    <AgentPet
      input={input}
      onInputChange={onInputChange}
      focusInputToken={focusInputToken}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      onOpenSettings={onOpenSettings}
    />
  );
}
