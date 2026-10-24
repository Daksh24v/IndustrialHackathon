/** The conversation at the bottom of the screen: messages, the agent's question as tappable chips, a text
 * field and a microphone button (voice comes from the voice branch). */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ScrollViewInstance } from 'react-native';

import type { Question } from '../api';
import { colours } from '../theme';

export interface Message {
  from: 'you' | 'guide';
  text: string;
}

interface Props {
  messages: Message[];
  question: Question | null;
  busy: boolean;
  onSend: (text: string) => void;
  onMic?: () => void;
}

export function ChatSheet({ messages, question, busy, onSend, onMic }: Props) {
  const [text, setText] = useState('');
  const scroll = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    scroll.current?.scrollToEnd({ animated: true });
  }, [messages, question]);

  const send = (value: string) => {
    const clean = value.trim();
    if (!clean || busy) return;
    onSend(clean);
    setText('');
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.handle} />
      {messages.length > 0 && (
        <ScrollView ref={scroll} style={styles.messages} contentContainerStyle={{ gap: 6 }}>
          {messages.map((message, index) => (
            <Text key={index} style={message.from === 'you' ? styles.you : styles.guide}>
              {message.text}
            </Text>
          ))}
        </ScrollView>
      )}
      {question && (
        <View testID="question">
          <Text style={styles.question}>{question.question}</Text>
          <View style={styles.chips}>
            {question.options.map((option) => (
              <Pressable key={option.label} testID={`chip-${option.label}`} style={styles.chip} disabled={busy}
                         onPress={() => send(option.label)}>
                <Text style={styles.chipText}>{option.label}</Text>
                {!!option.description && <Text style={styles.chipDetail}>{option.description}</Text>}
              </Pressable>
            ))}
          </View>
        </View>
      )}
      <View style={styles.inputRow}>
        <TextInput
          testID="chat-input"
          style={styles.input}
          placeholder="Where do you want to go?"
          placeholderTextColor={colours.muted}
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => send(text)}
          returnKeyType="send"
          editable={!busy}
        />
        {busy ? (
          <ActivityIndicator color={colours.accent} style={styles.round} />
        ) : text.trim() ? (
          <Pressable testID="send" accessibilityLabel="Send" style={[styles.round, styles.send]} onPress={() => send(text)}>
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
        ) : (
          <Pressable testID="mic" accessibilityLabel="Speak" style={styles.round} onPress={onMic}>
            <Text style={styles.mic}>🎙</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colours.background, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16,
    paddingBottom: 16, paddingTop: 8, gap: 10, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 }, elevation: 8,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colours.blockEdge },
  messages: { maxHeight: 160 },
  you: { alignSelf: 'flex-end', backgroundColor: colours.chip, color: colours.text, paddingHorizontal: 12, paddingVertical: 8,
         borderRadius: 14, overflow: 'hidden', maxWidth: '85%' },
  guide: { alignSelf: 'flex-start', color: colours.text, maxWidth: '92%', lineHeight: 20 },
  question: { color: colours.text, fontWeight: '600', marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: colours.chip, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8,
          borderWidth: StyleSheet.hairlineWidth, borderColor: colours.blockEdge },
  chipText: { color: colours.chipText, fontWeight: '500' },
  chipDetail: { color: colours.muted, fontSize: 11 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, backgroundColor: colours.chip, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 11,
           fontSize: 16, color: colours.text },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  send: { backgroundColor: colours.accent },
  sendText: { color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
  mic: { fontSize: 20 },
});
