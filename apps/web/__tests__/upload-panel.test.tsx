import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UploadPanel } from '@/components/upload/upload-panel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('UploadPanel', () => {
  it('présente la zone d’import et ses limites', () => {
    render(<UploadPanel />);
    expect(screen.getByText('Glissez votre document Word ici')).toBeInTheDocument();
    expect(screen.getByText(/20 Mo maximum/)).toBeInTheDocument();
  });

  it('refuse immédiatement un fichier qui n’est pas un .docx, sans l’envoyer', async () => {
    const send = vi.spyOn(XMLHttpRequest.prototype, 'send');
    render(<UploadPanel />);
    const input = screen.getByLabelText(/Glissez votre document Word ici/);
    await userEvent.upload(input, new File(['%PDF'], 'rapport.pdf', { type: 'application/pdf' }), {
      applyAccept: false,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('pas un document Word');
    expect(send).not.toHaveBeenCalled();
  });
});
