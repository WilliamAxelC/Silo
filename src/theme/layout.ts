import type { ViewStyle } from 'react-native';

/**
 * Widths for tablets, foldables and landscape. Phones are narrower than all of these, so nothing
 * changes there; on wide screens the app becomes a centred column and popups stop stretching edge to edge.
 */
export const MAX_CONTENT_WIDTH = 720;

/** Bottom sheets (Edit account, pickers, filters). */
export const SHEET_WIDTH: ViewStyle = { width: '100%', maxWidth: 640, alignSelf: 'center' };

/** Centred dialogs (confirmations, small forms). */
export const DIALOG_WIDTH: ViewStyle = { width: '100%', maxWidth: 480, alignSelf: 'center' };
