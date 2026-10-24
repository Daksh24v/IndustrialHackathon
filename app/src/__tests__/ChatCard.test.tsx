import { fireEvent, render, screen } from '@testing-library/react-native';

import { ChatCard, STARTERS } from '../components/ChatCard';

const question = {
  question: 'Which floor are you on?',
  options: [{ label: 'Ground floor' }, { label: 'Floor 1', description: 'upstairs' }],
  allow_free_text: true,
};

describe('ChatCard', () => {
  it('starts with the Finni field, the mic and example questions', async () => {
    const onSend = jest.fn();
    const onMic = jest.fn();
    await render(<ChatCard messages={[]} question={null} busy={false} onSend={onSend} onMic={onMic} />);
    expect(screen.getByPlaceholderText('Talk to Finni…')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('mic'));
    expect(onMic).toHaveBeenCalled();
    expect(screen.queryByTestId('chat-card')).toBeNull();
    await fireEvent.press(screen.getByTestId(`starter-${STARTERS[0]}`));
    expect(onSend).toHaveBeenCalledWith(STARTERS[0]);
  });

  it('shows the question as chips and sends the tapped option', async () => {
    const onSend = jest.fn();
    await render(<ChatCard messages={[{ from: 'you', text: 'Where is the toilet?' }]} question={question} busy={false}
                           onSend={onSend} />);
    expect(screen.getByText('Which floor are you on?')).toBeTruthy();
    expect(screen.getByText('upstairs')).toBeTruthy();
    expect(screen.queryByTestId(`starter-${STARTERS[0]}`)).toBeNull();
    await fireEvent.press(screen.getByTestId('chip-Floor 1'));
    expect(onSend).toHaveBeenCalledWith('Floor 1');
  });

  it('sends typed text with the send arrow and ignores empty input', async () => {
    const onSend = jest.fn();
    await render(<ChatCard messages={[]} question={null} busy={false} onSend={onSend} />);
    await fireEvent(screen.getByTestId('chat-input'), 'submitEditing');
    expect(onSend).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('chat-input'), '  Where is the CNC mill?  ');
    expect(screen.queryByTestId('mic')).toBeNull();
    await fireEvent.press(screen.getByTestId('send'));
    expect(onSend).toHaveBeenCalledWith('Where is the CNC mill?');
  });

  it('does not send while Finni is answering', async () => {
    const onSend = jest.fn();
    await render(<ChatCard messages={[]} question={question} busy onSend={onSend} />);
    await fireEvent.press(screen.getByTestId('chip-Ground floor'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('folds the conversation away and back', async () => {
    await render(<ChatCard messages={[{ from: 'guide', text: 'It is on Floor 1.' }]} question={question} busy={false}
                           onSend={jest.fn()} />);
    await fireEvent.press(screen.getByTestId('fold'));
    expect(screen.queryByTestId('question')).toBeNull();
    expect(screen.getByText('It is on Floor 1.')).toBeTruthy(); // the last line stays visible
    await fireEvent.press(screen.getByTestId('fold'));
    expect(screen.getByTestId('question')).toBeTruthy();
  });
});
