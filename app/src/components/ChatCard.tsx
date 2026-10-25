/** The conversation at the top, under the logo (so the keyboard never covers it): the "Talk to FINNI…" field
 * with an orange mic (src/useVoice.ts: tap once to talk, again to interrupt or stop), and under it a card with
 * the replies and the agent's question as tappable chips. The card folds away to give the map more room.
 * On a wide screen (side) it is a full-height panel beside the map instead, and the messages fill it. */
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

/** Messages are shown as plain text: drop markdown emphasis and heading marks if the guide still writes them. */
export function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^#{1,6}\s+/gm, '');
}

interface Props {
  messages: Message[];
  question: Question | null;
  busy: boolean;
  onSend: (text: string) => void;
  onMic?: () => void;
  mic?: MicState;
  side?: boolean; // a full-height panel beside the map (wide screens)
  note?: string | null; // a short, quiet line under the messages, e.g. a new conversation was started
}

const MIC_HINT: Record<MicState, string> = {
  off: '',
  listening: 'Listening… pause when you are done',
  thinking: '',
  speaking: 'Speaking… tap the mic to interrupt',
};

export function ChatCard({ messages, question, busy, onSend, onMic, mic = 'off', side = false, note }: Props) {
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
  const shown = open || side;
  return (
    <View style={[styles.wrap, side && styles.wrapSide]}>
      <View style={styles.inputRow}>
        <TextInput
          testID="chat-input"
          style={styles.input}
          placeholder="Talk to FINNI…"
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
          <Pressable testID="mic" accessibilityLabel={mic === 'off' ? 'Speak to FINNI' : 'Stop'}
                     accessibilityState={{ selected: mic !== 'off' }}
                     style={[styles.round, mic !== 'off' && styles.micOn]} onPress={onMic}>
            <MicIcon colour={mic === 'off' ? colours.accent : '#FFFFFF'} />
          </Pressable>
        )}
      </View>
      {MIC_HINT[mic] ? <Text testID="mic-hint" style={styles.micHint}>{MIC_HINT[mic]}</Text> : null}

      {!talking && (
        <ScrollView horizontal={!side} showsHorizontalScrollIndicator={false}
                    contentContainerStyle={[styles.starters, side && styles.startersSide]}>
          {STARTERS.map((starter) => (
            <Pressable key={starter} testID={`starter-${starter}`} style={styles.starter} onPress={() => send(starter)}>
              <Text style={styles.starterText}>{starter}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {talking && (
        <View style={[styles.card, side && styles.cardSide]} testID="chat-card">
          {!side && (
            <Pressable testID="fold" accessibilityLabel={open ? 'Hide the conversation' : 'Show the conversation'}
                       style={styles.fold} onPress={() => setOpen(!open)} hitSlop={8}>
              <View style={styles.handle} />
            </Pressable>
          )}
          {shown && (
            <>
              <ScrollView ref={scroll} testID="messages" style={side ? styles.messagesSide : styles.messages}
                          contentContainerStyle={{ gap: 6 }}>
                {messages.map((message, index) => (
                  <Text key={index} style={message.from === 'you' ? styles.you : styles.guide}>
                    {plain(message.text)}
                  </Text>
                ))}
                {busy && <Text style={styles.thinking}>FINNI is looking…</Text>}
                {!!note && <Text testID="note" style={styles.note}>{note}</Text>}
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
          {!shown && messages.length > 0 && (
            <Text style={styles.folded} numberOfLines={1}>{plain(messages[messages.length - 1].text)}</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, gap: 10, paddingBottom: 8 },
  wrapSide: { flex: 1, paddingBottom: 16 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colours.background, borderRadius: 24,
    paddingLeft: 18, paddingRight: 4, borderWidth: 1, borderColor: '#ECECEC',
    shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 3,
  },
  input: { flex: 1, paddingVertical: 12, fontSize: 16, color: colours.text },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  send: { backgroundColor: colours.accent },
  micOn: { backgroundColor: colours.accent },
  micHint: { color: colours.accent, fontSize: 12, textAlign: 'center', marginTop: -4 },
  starters: { gap: 8 },
  startersSide: { flexDirection: 'row', flexWrap: 'wrap' },
  starter: { backgroundColor: colours.chip, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  starterText: { color: colours.chipText, fontSize: 13 },
  card: {
    backgroundColor: colours.background, borderRadius: 18, padding: 12, paddingTop: 4, gap: 8,
    borderWidth: 1, borderColor: '#F0F0F0',
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  cardSide: { flex: 1, paddingTop: 12 },
  fold: { alignSelf: 'center', paddingVertical: 4 },
  handle: { width: 32, height: 4, borderRadius: 2, backgroundColor: colours.blockEdge },
  messages: { maxHeight: 120 },
  messagesSide: { flex: 1 },
  you: { alignSelf: 'flex-end', backgroundColor: colours.chip, color: colours.text, paddingHorizontal: 12, paddingVertical: 7,
         borderRadius: 14, overflow: 'hidden', maxWidth: '85%' },
  guide: { alignSelf: 'flex-start', color: colours.text, maxWidth: '94%', lineHeight: 20 },
  thinking: { color: colours.muted, fontStyle: 'italic' },
  note: { color: colours.muted, fontSize: 12, alignSelf: 'center', textAlign: 'center' },
  folded: { color: colours.muted },
  question: { color: colours.text, fontWeight: '600', marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#FFF4EA', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8,
          borderWidth: 1, borderColor: '#FFD9B5' },
  chipText: { color: colours.chipText, fontWeight: '600' },
  chipDetail: { color: colours.muted, fontSize: 11 },
});
