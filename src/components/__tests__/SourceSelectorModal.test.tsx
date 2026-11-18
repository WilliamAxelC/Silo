import React from 'react';
import { Modal } from 'react-native';
import { SourceSelectorModal } from '../SourceSelectorModal';

const ReactTestRenderer = require('react-test-renderer');

describe('SourceSelectorModal', () => {
  it('wires onRequestClose={onClose} and accessible source buttons', () => {
    const onClose = jest.fn();
    const onPickImage = jest.fn();
    let renderer: any;

    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <SourceSelectorModal visible={true} onClose={onClose} onPickImage={onPickImage} />
      );
    });

    const modal = renderer.root.findByType(Modal);
    expect(modal.props.onRequestClose).toBe(onClose);

    const galleryBtn = renderer.root.findByProps({ accessibilityLabel: 'Select from gallery' });
    expect(galleryBtn.props.accessibilityRole).toBe('button');
    ReactTestRenderer.act(() => {
      galleryBtn.props.onPress();
    });
    expect(onPickImage).toHaveBeenCalledWith('gallery');

    const cameraBtn = renderer.root.findByProps({ accessibilityLabel: 'Take photo with camera' });
    expect(cameraBtn.props.accessibilityRole).toBe('button');

    const cancelBtn = renderer.root.findByProps({ accessibilityLabel: 'Cancel' });
    expect(cancelBtn.props.accessibilityRole).toBe('button');
  });
});
