import React from 'react';
import { Alert, Text } from 'react-native';
import { SettingsScreen } from '../SettingsScreen';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useAIStore, createInitialProvisioningSnapshot, createInitialRuntimeSnapshot } from '../../store/useAIStore';
import { useTransactionStore } from '../../store/useTransactionStore';
import * as modelLifecycle from '../../services/ai/modelLifecycle';

const ReactTestRenderer = require('react-test-renderer');

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
  };
});

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/user/0/com.silo.app/files/',
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: { UTF8: 'utf8' },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/ai/modelLifecycle', () => ({
  getModelLifecycleManager: jest.fn(() => ({
    retryProvisioning: jest.fn(),
    cancelDownload: jest.fn(),
    deleteInstalledModel: jest.fn(),
  })),
  isActiveModelInstalled: jest.fn().mockResolvedValue(true),
  isVisionProjectorInstalled: jest.fn().mockResolvedValue(false),
  downloadVisionProjector: jest.fn().mockResolvedValue(undefined),
  cancelVisionProjectorDownload: jest.fn().mockResolvedValue(undefined),
  deleteVisionProjector: jest.fn().mockResolvedValue(undefined),
}));

describe('SettingsScreen - Receipt reading mode & Vision projector', () => {
  let renderer: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (modelLifecycle.isActiveModelInstalled as jest.Mock).mockResolvedValue(true);
    (modelLifecycle.isVisionProjectorInstalled as jest.Mock).mockResolvedValue(false);

    ReactTestRenderer.act(() => {
      useSettingsStore.setState({
        receiptReadingMode: 'ocr',
        aiInferenceMode: 'local',
        fontScale: 1.0,
      });

      const readyProvisioning = createInitialProvisioningSnapshot();
      readyProvisioning.status = 'ready';
      useAIStore.setState({
        provisioning: readyProvisioning,
        runtime: createInitialRuntimeSnapshot(),
      });

      useTransactionStore.setState({
        transactionsList: [],
        categories: [],
      });
    });
  });

  afterEach(() => {
    if (renderer) {
      ReactTestRenderer.act(() => {
        renderer.unmount();
      });
      renderer = null;
    }
  });

  it('renders receipt reading mode options with explanation', async () => {
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const fastChip = renderer.root.findByProps({ accessibilityLabel: 'Fast (text OCR)' });
    const visionChip = renderer.root.findByProps({ accessibilityLabel: 'Accurate (AI vision)' });
    expect(fastChip).toBeTruthy();
    expect(visionChip).toBeTruthy();

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children);
    const joined = texts.flat().join(' ');
    expect(joined).toContain('Receipt reading');
    expect(joined).toContain('AI vision reads the photo directly: more accurate');
  });

  it('shows download vision add-on button when vision is selected and projector is not installed', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision' });
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const downloadBtn = renderer.root.findByProps({ accessibilityLabel: 'Download vision add-on (670 MB)' });
    expect(downloadBtn).toBeTruthy();
    expect(downloadBtn.props.accessibilityRole).toBe('button');
  });

  it('handles download, progress, cancel, and success flow for vision projector', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision' });
    });

    let progressCb: ((fraction: number) => void) | undefined;
    (modelLifecycle.downloadVisionProjector as jest.Mock).mockImplementation((cb) => {
      progressCb = cb;
      return new Promise(() => {}); // stays in progress
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const downloadBtn = renderer.root.findByProps({ accessibilityLabel: 'Download vision add-on (670 MB)' });

    await ReactTestRenderer.act(async () => {
      downloadBtn.props.onPress();
    });

    expect(modelLifecycle.downloadVisionProjector).toHaveBeenCalled();

    // Trigger progress
    if (progressCb) {
      await ReactTestRenderer.act(async () => {
        progressCb!(0.45);
      });
    }

    const cancelBtn = renderer.root.findByProps({ accessibilityLabel: 'Cancel vision download' });
    expect(cancelBtn).toBeTruthy();

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('45% completed');

    // Test cancel
    await ReactTestRenderer.act(async () => {
      cancelBtn.props.onPress();
    });
    expect(modelLifecycle.cancelVisionProjectorDownload).toHaveBeenCalled();
  });

  it('shows installed badge and remove button when projector is installed, and confirms deletion', async () => {
    (modelLifecycle.isVisionProjectorInstalled as jest.Mock).mockResolvedValue(true);
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision' });
    });

    const alertSpy = jest.spyOn(Alert, 'alert');

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const removeBtn = renderer.root.findByProps({ accessibilityLabel: 'Remove vision add-on' });
    expect(removeBtn).toBeTruthy();

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('Vision add-on installed');

    // Click remove button -> triggers Alert
    await ReactTestRenderer.act(async () => {
      removeBtn.props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Remove Vision Add-on',
      expect.stringContaining('670 MB'),
      expect.any(Array)
    );

    // Trigger the destructive action in Alert
    const alertButtons = alertSpy.mock.calls[0][2] as any[];
    const destructiveBtn = alertButtons.find((b) => b.style === 'destructive');
    expect(destructiveBtn).toBeTruthy();

    await ReactTestRenderer.act(async () => {
      await destructiveBtn.onPress();
    });

    expect(modelLifecycle.deleteVisionProjector).toHaveBeenCalled();
  });

  it('shows retry button and error text when projector download fails', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision' });
    });
    (modelLifecycle.downloadVisionProjector as jest.Mock).mockRejectedValueOnce(new Error('Network connection timed out'));

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const downloadBtn = renderer.root.findByProps({ accessibilityLabel: 'Download vision add-on (670 MB)' });
    await ReactTestRenderer.act(async () => {
      await downloadBtn.props.onPress();
    });

    const retryBtn = renderer.root.findByProps({ accessibilityLabel: 'Retry vision download' });
    expect(retryBtn).toBeTruthy();

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('Network connection timed out');
  });

  it('notifies user that AI model must be downloaded first if local model is not installed', async () => {
    (modelLifecycle.isActiveModelInstalled as jest.Mock).mockResolvedValue(false);

    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision', aiInferenceMode: 'local' });
      const notInstalledProvisioning = createInitialProvisioningSnapshot();
      notInstalledProvisioning.status = 'not-installed';
      useAIStore.setState({ provisioning: notInstalledProvisioning });
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('AI model must be downloaded first');
  });

  it('shows that external mode needs no download', async () => {
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ receiptReadingMode: 'vision', aiInferenceMode: 'external' });
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const texts = renderer.root.findAllByType(Text).map((t: any) => t.props.children).flat().join(' ');
    expect(texts).toContain('External mode needs no download.');
  });

  it('exports CSV with Transfer type and Account / To Account columns', async () => {
    const { writeAsStringAsync } = require('expo-file-system/legacy');
    ReactTestRenderer.act(() => {
      useSettingsStore.setState({ dateFormat: 'en-GB' });
      useTransactionStore.setState({
        wallets: [
          { id: 1, name: 'BCA', type: 'bank', isActive: true, initialBalance: 0, balance: 0 },
          { id: 2, name: 'GoPay', type: 'ewallet', isActive: true, initialBalance: 0, balance: 0 },
        ],
        transactionsList: [
          {
            id: 1,
            merchantName: 'Top up',
            totalAmount: -250000,
            type: 'transfer',
            category: 'Transfer',
            date: new Date(2026, 10, 15).getTime(),
            note: '',
            lineItemsText: '',
            walletId: 1,
            toWalletId: 2,
          },
        ],
      } as any);
    });

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<SettingsScreen />);
    });

    const exportBtn = renderer.root.findByProps({ accessibilityLabel: 'Export Transactions CSV' });
    await ReactTestRenderer.act(async () => {
      await exportBtn.props.onPress();
    });

    expect(writeAsStringAsync).toHaveBeenCalledTimes(1);
    const writtenCsv: string = (writeAsStringAsync as jest.Mock).mock.calls[0][1];
    expect(writtenCsv).toContain('Date,Merchant Name,Category,Amount,Type,Account,To Account,Description,Receipt Items');
    expect(writtenCsv).toContain(',Transfer,"BCA","GoPay",');
  });
});
