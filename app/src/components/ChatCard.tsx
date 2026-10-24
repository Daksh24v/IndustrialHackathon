/** The conversation at the top, under the logo (so the keyboard never covers it): the "Talk to Finni…" field
 * with an orange mic (src/useVoice.ts: tap once to talk, again to interrupt or stop), and under it a card with
 * the replies and the agent's question as tappable chips. The card folds away to give the map more room. */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ScrollViewInstance } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import type { Question } from '../api';
import { colours } from '../theme';
import type { MicState } from '../useVoice';
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
  mic?: MicState;
  tall?: boolean; // in a sidebar (laptops): the conversation fills the height
}

const MIC_HINT: Record<MicState, string> = {
  off: '',
  listening: 'Listening… pause when you are done',
  thinking: '',
  speaking: 'Speaking… tap the mic to interrupt',
};

export function ChatCard({ messages, question, busy, onSend, onMic, mic = 'off', tall = false }: Props) {
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
    <View style={[styles.wrap, tall && styles.fill]}>
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
        {busy || mic === 'thinking' ? (
          <ActivityIndicator color={colours.accent} style={styles.round} />
        ) : text.trim() ? (
          <Pressable testID="send" accessibilityLabel="Send" style={[styles.round, styles.send]} onPress={() => send(text)}>
            <Svg width={18} height={18} viewBox="0 0 24 24">
              <Path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" stroke="#FFFFFF" strokeWidth={2.6} strokeLinecap="round"
                    strokeLinejoin="round" fill="none" />
            </Svg>
          </Pressable>
        ) : (
          <Pressable testID="mic" accessibilityLabel={mic === 'off' ? 'Speak to Finni' : 'Stop'}
                     accessibilityState={{ selected: mic !== 'off' }}
                     style={[styles.round, mic !== 'off' && styles.micOn]} onPress={onMic}>
            <MicIcon colour={mic === 'off' ? colours.accent : '#FFFFFF'} />
          </Pressable>
        )}
      </View>
      {MIC_HINT[mic] ? <Text testID="mic-hint" style={styles.micHint}>{MIC_HINT[mic]}</Text> : null}

      {!talking && (
        <ScrollView horizontal={!tall} showsHorizontalScrollIndicator={false}
                    contentContainerStyle={[styles.starters, tall && styles.startersTall]}>
          {STARTERS.map((starter) => (
            <Pressable key={starter} testID={`starter-${starter}`} style={styles.starter} onPress={() => send(starter)}>
              <Text style={styles.starterText}>{starter}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {talking && (
        <View style={[styles.card, tall && open && styles.fill]} testID="chat-card">
          <Pressable testID="fold" accessibilityLabel={open ? 'Hide the conversation' : 'Show the conversation'}
                     style={styles.fold} onPress={() => setOpen(!open)} hitSlop={8}>
            <View style={styles.handle} />
          </Pressable>
          {open && (
            <>
              <ScrollView ref={scroll} style={tall ? styles.fill : styles.messages} contentContainerStyle={{ gap: 6 }}>
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
  fill: { flex: 1 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colours.surface, borderRadius: 24,
    paddingLeft: 18, paddingRight: 4, borderWidth: 1, borderColor: colours.line,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 3,
  },
  input: { flex: 1, paddingVertical: 12, fontSize: 16, color: colours.text },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  send: { backgroundColor: colours.accent },
  micOn: { backgroundColor: colours.accent },
  micHint: { color: colours.accent, fontSize: 12, textAlign: 'center', marginTop: -4 },
  starters: { gap: 8 },
  startersTall: { flexDirection: 'row', flexWrap: 'wrap' },
  starter: { backgroundColor: colours.surfaceRaised, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  starterText: { color: colours.chipText, fontSize: 13 },
  card: {
    backgroundColor: colours.surface, borderRadius: 18, padding: 12, paddingTop: 4, gap: 8,
    borderWidth: 1, borderColor: colours.line,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  fold: { alignSelf: 'center', paddingVertical: 4 },
  handle: { width: 32, height: 4, borderRadius: 2, backgroundColor: colours.blockEdge },
  messages: { maxHeight: 120 },
  you: { alignSelf: 'flex-end', backgroundColor: colours.surfaceRaised, color: colours.text, paddingHorizontal: 12, paddingVertical: 7,
         borderRadius: 14, overflow: 'hidden', maxWidth: '85%' },
  guide: { alignSelf: 'flex-start', color: colours.text, maxWidth: '94%', lineHeight: 20 },
  thinking: { color: colours.muted, fontStyle: 'italic' },
  folded: { color: colours.muted },
  question: { color: colours.text, fontWeight: '600', marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: colours.accentChip, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8,
          borderWidth: 1, borderColor: colours.accentSoft },
  chipText: { color: colours.chipText, fontWeight: '600' },
  chipDetail: { color: colours.muted, fontSize: 11 },
});
