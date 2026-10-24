import { fireEvent, render, screen } from '@testing-library/react-native';

import { ChatSheet } from '../components/ChatSheet';

const question = {
  question: 'Which floor are you on?',
  options: [{ label: 'Ground floor' }, { label: 'Floor 1', description: 'upstairs' }],
  allow_free_text: true,
};

describe('ChatSheet', () => {
  it('shows the question as chips and sends the tapped option', async () => {
    const onSend = jest.fn();
    await render(<ChatSheet messages={[{ from: 'you', text: 'Where is the toilet?' }]} question={question} busy={false}
                            onSend={onSend} />);
    expect(screen.getByText('Which floor are you on?')).toBeTruthy();
    expect(screen.getByText('upstairs')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('chip-Floor 1'));
    expect(onSend).toHaveBeenCalledWith('Floor 1');
  });

  it('sends typed text and ignores empty input', async () => {
    const onSend = jest.fn();
    await render(<ChatSheet messages={[]} question={null} busy={false} onSend={onSend} />);
    await fireEvent(screen.getByTestId('chat-input'), 'submitEditing');
    expect(onSend).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('chat-input'), '  Where is the CNC mill?  ');
    await fireEvent.press(screen.getByTestId('send'));
    expect(onSend).toHaveBeenCalledWith('Where is the CNC mill?');
  });

  it('does not send while the guide is answering', async () => {
    const onSend = jest.fn();
    await render(<ChatSheet messages={[]} question={question} busy onSend={onSend} />);
    await fireEvent.press(screen.getByTestId('chip-Ground floor'));
    expect(onSend).not.toHaveBeenCalled();
  });
});
