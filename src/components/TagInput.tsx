import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { normalizeTagNames } from '../features/transactions/factories';
import { useAppTheme } from '../theme/useAppTheme';

interface TagInputProps {
  tags: string[];
  /** Existing tag names, most used first. */
  suggestions: string[];
  onChange: (tags: string[]) => void;
}

/** Free-form tags ("date", "Japan 2026") alongside the single category: selected chips, a text box and quick picks. */
export function TagInput({ tags, suggestions, onChange }: TagInputProps) {
  const theme = useAppTheme();
  const [draft, setDraft] = useState('');
  const selected = useMemo(() => new Set(tags.map((t) => t.toLowerCase())), [tags]);
  const query = draft.replace(/^#+/, '').trim().toLowerCase();
  const picks = useMemo(
    () =>
      suggestions
        .filter((name) => !selected.has(name.toLowerCase()))
        .filter((name) => !query || name.toLowerCase().includes(query))
        .slice(0, 6),
    [suggestions, selected, query]
  );

  const add = (name: string) => {
    const next = normalizeTagNames([...tags, name]);
    if (next.length !== tags.length) onChange(next);
    setDraft('');
  };
  const remove = (name: string) => onChange(tags.filter((t) => t !== name));

  const chip = (label: string, active: boolean) => ({
    style: [
      styles.chip,
      {
        borderColor: active ? theme.primary : theme.border,
        backgroundColor: active ? theme.primaryMuted : 'transparent',
      },
    ],
    text: { color: active ? theme.primary : theme.text, fontSize: theme.scaleFont(12), fontWeight: '600' as const },
    label,
  });

  return (
    <View style={styles.wrap} testID="tag-input">
      <View style={styles.row}>
        {tags.map((name) => {
          const c = chip(name, true);
          return (
            <TouchableOpacity
              key={name}
              style={c.style}
              onPress={() => remove(name)}
              accessibilityRole="button"
              accessibilityLabel={`Remove tag ${name}`}
            >
              <Text style={c.text}>#{name}</Text>
              <Ionicons name="close" size={12} color={theme.primary} />
            </TouchableOpacity>
          );
        })}
        <TextInput
          style={[styles.input, { borderColor: theme.border, color: theme.text, fontSize: theme.scaleFont(13) }]}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => draft.trim() && add(draft)}
          placeholder={tags.length ? 'Add another' : 'Add a tag, e.g. date'}
          placeholderTextColor={theme.textMuted}
          returnKeyType="done"
          blurOnSubmit={false}
          autoCapitalize="none"
          accessibilityLabel="Add tag"
        />
        {query && !picks.some((p) => p.toLowerCase() === query) && !selected.has(query) ? (
          <TouchableOpacity
            style={chip('', false).style}
            onPress={() => add(draft)}
            accessibilityRole="button"
            accessibilityLabel={`Create tag ${draft.trim()}`}
          >
            <Ionicons name="add" size={12} color={theme.primary} />
            <Text style={chip('', false).text}>#{draft.replace(/^#+/, '').trim()}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {picks.length > 0 ? (
        <View style={styles.row}>
          {picks.map((name) => {
            const c = chip(name, false);
            return (
              <TouchableOpacity
                key={name}
                style={c.style}
                onPress={() => add(name)}
                accessibilityRole="button"
                accessibilityLabel={`Add tag ${name}`}
              >
                <Text style={[c.text, { color: theme.textMuted }]}>#{name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, minHeight: 32 },
  input: { flexGrow: 1, minWidth: 140, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, minHeight: 36 },
});
