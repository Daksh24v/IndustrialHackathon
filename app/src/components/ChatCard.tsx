/** The conversation at the top, under the logo (so the keyboard never covers it): the "Talk to Finni…" field
 * with an orange mic (voice comes from the voice branch), and under it a card with the replies and the
 * agent's question as tappable chips. The card folds away to give the map more room. */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ScrollViewInstance } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import type { Question } from '../api';
import { colours } from '../theme';
import { MicIcon } from './MicIcon';

export interface Message {
  from: 'you' | 'guide';
  text: string;
}

export const STARTERS = ["Where's the coffee machine?", "Where's the nearest exit?", 'Find a toilet'];

interface Props {
  messages: Message[];
  question: Question | null;
  busy: boolean;
  onSend: (text: string) => void;
  onMic?: () => void;
}

export function ChatCard({ messages, question, busy, onSend, onMic }: Props) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(true);
  const scroll = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    setOpen(true); // something new to read
    scroll.current?.scrollToEnd({ animated: true });
  }, [messages, question]);

  const send = (value: string) => {
    const clean = value.trim();
    if (!clean || busy) return;
    onSend(clean);
    setText('');
  };

  const talking = messages.length > 0 || !!question || busy;
  return (
    <View style={styles.wrap}>
      <View style={styles.inputRow}>
        <TextInput
          testID="chat-input"
          style={styles.input}
          placeholder="Talk to Finni…"
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
            <Svg width={18} height={18} viewBox="0 0 24 24">
              <Path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" stroke="#FFFFFF" strokeWidth={2.6} strokeLinecap="round"
                    strokeLinejoin="round" fill="none" />
            </Svg>
          </Pressable>
        ) : (
          <Pressable testID="mic" accessibilityLabel="Speak to Finni" style={styles.round} onPress={onMic}>
            <MicIcon />
          </Pressable>
        )}
      </View>

      {!talking && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.starters}>
          {STARTERS.map((starter) => (
            <Pressable key={starter} testID={`starter-${starter}`} style={styles.starter} onPress={() => send(starter)}>
              <Text style={styles.starterText}>{starter}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {talking && (
        <View style={styles.card} testID="chat-card">
          <Pressable testID="fold" accessibilityLabel={open ? 'Hide the conversation' : 'Show the conversation'}
                     style={styles.fold} onPress={() => setOpen(!open)} hitSlop={8}>
            <View style={styles.handle} />
          </Pressable>
          {open && (
            <>
              <ScrollView ref={scroll} style={styles.messages} contentContainerStyle={{ gap: 6 }}>
                {messages.map((message, index) => (
                  <Text key={index} style={message.from === 'you' ? styles.you : styles.guide}>
                    {message.text}
                  </Text>
                ))}
                {busy && <Text style={styles.thinking}>Finni is looking…</Text>}
              </ScrollView>
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
            </>
          )}
          {!open && messages.length > 0 && (
            <Text style={styles.folded} numberOfLines={1}>{messages[messages.length - 1].text}</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, gap: 10, paddingBottom: 8 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colours.background, borderRadius: 24,
    paddingLeft: 18, paddingRight: 4, borderWidth: 1, borderColor: '#ECECEC',
    shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 3,
  },
  input: { flex: 1, paddingVertical: 12, fontSize: 16, color: colours.text },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  send: { backgroundColor: colours.accent },
  starters: { gap: 8 },
  starter: { backgroundColor: colours.chip, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  starterText: { color: colours.chipText, fontSize: 13 },
  card: {
    backgroundColor: colours.background, borderRadius: 18, padding: 12, paddingTop: 4, gap: 8,
    borderWidth: 1, borderColor: '#F0F0F0',
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  fold: { alignSelf: 'center', paddingVertical: 4 },
  handle: { width: 32, height: 4, borderRadius: 2, backgroundColor: colours.blockEdge },
  messages: { maxHeight: 120 },
  you: { alignSelf: 'flex-end', backgroundColor: colours.chip, color: colours.text, paddingHorizontal: 12, paddingVertical: 7,
         borderRadius: 14, overflow: 'hidden', maxWidth: '85%' },
  guide: { alignSelf: 'flex-start', color: colours.text, maxWidth: '94%', lineHeight: 20 },
  thinking: { color: colours.muted, fontStyle: 'italic' },
  folded: { color: colours.muted },
  question: { color: colours.text, fontWeight: '600', marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#FFF4EA', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8,
          borderWidth: 1, borderColor: '#FFD9B5' },
  chipText: { color: colours.chipText, fontWeight: '600' },
  chipDetail: { color: colours.muted, fontSize: 11 },
});
