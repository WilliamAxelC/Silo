import { buildPromptForMode, buildExternalMessagesForMode, type RetrievedContextItem } from '../agent';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useAIStore } from '../../../store/useAIStore';

// Mock the Zustand stores
jest.mock('../../../store/useSettingsStore', () => ({
  useSettingsStore: {
    getState: jest.fn(),
  },
}));

jest.mock('../../../store/useAIStore', () => ({
  useAIStore: {
    getState: jest.fn(),
  },
}));

describe('agent prompt builders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    (useSettingsStore.getState as jest.Mock).mockReturnValue({
      localSystemPrompt: 'Custom local system prompt',
      externalSystemPrompt: 'Custom external system prompt',
    });

    (useAIStore.getState as jest.Mock).mockReturnValue({
      runtime: {
        runtimeInfo: {
          backend: 'llama.rn',
          loadedModelFamily: 'qwen',
        }
      },
      chatHistory: [
        { id: '1', role: 'user', text: 'Hello', status: 'complete' },
        { id: '2', role: 'ai', text: 'Hi there', status: 'complete' }
      ],
    });
  });

  describe('buildPromptForMode (Local Inference)', () => {
    it('uses the custom local system prompt for chat mode', () => {
      const prompt = buildPromptForMode('What is my balance?', 'chat', useAIStore.getState());
      
      expect(prompt).toContain('Custom local system prompt');
      expect(prompt).toContain('Hello'); // includes history
      expect(prompt).toContain('What is my balance?'); // includes user query
    });

    it('injects retrieved context into the system prompt for rag mode', () => {
      const retrievedContext: RetrievedContextItem[] = [
        { id: 'tx-1', kind: 'transaction', label: 'Coffee', content: 'Coffee Shop Expense $4.50', score: 100 }
      ];

      const prompt = buildPromptForMode('How much was coffee?', 'rag', useAIStore.getState(), retrievedContext);
      
      expect(prompt).toContain('Custom local system prompt');
      expect(prompt).toContain('Coffee Shop Expense $4.50');
      expect(prompt).toContain('How much was coffee?');
    });
  });

  describe('buildExternalMessagesForMode (External API)', () => {
    it('uses the custom external system prompt and formats history', () => {
      const messages = buildExternalMessagesForMode('Tell me a joke', 'chat', useAIStore.getState());
      
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe('Custom external system prompt');
      
      expect(messages.length).toBe(4); // system, user, ai, user
      expect(messages[3].content).toBe('Tell me a joke');
    });

    it('injects retrieved context for external API grounded queries', () => {
      const retrievedContext: RetrievedContextItem[] = [
        { id: 'tx-2', kind: 'transaction', label: 'Rent', content: 'Apartment Rent $1200', score: 100 }
      ];

      const messages = buildExternalMessagesForMode('How much is rent?', 'rag', useAIStore.getState(), retrievedContext);
      
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('Custom external system prompt');
      expect(messages[0].content).toContain('Apartment Rent $1200');
    });
  });
});
