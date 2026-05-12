import { create } from 'zustand';

export interface Message { role: 'user' | 'ai'; text: string; }
export interface AIModel { name: string; displayName: string; inputTokenLimit: number; description: string; }

interface AIState {
  apiKey: string | null;
  selectedModel: string | null;
  availableModels: AIModel[];
  chatHistory: Message[];
  setApiKey: (key: string) => void;
  setSelectedModel: (model: string) => void;
  setAvailableModels: (models: AIModel[]) => void;
  addChatMessage: (msg: Message) => void;
  clearChatHistory: () => void;
}

export const useAIStore = create<AIState>((set) => ({
  apiKey: null,
  selectedModel: null,
  availableModels: [],
  chatHistory: [],
  setApiKey: (key) => set({ apiKey: key }),
  setSelectedModel: (model) => set({ selectedModel: model }),
  setAvailableModels: (models) => set({ availableModels: models }),
  addChatMessage: (msg) => set((state) => ({ chatHistory: [...state.chatHistory, msg] })),
  clearChatHistory: () => set({ chatHistory: [] }),
}));