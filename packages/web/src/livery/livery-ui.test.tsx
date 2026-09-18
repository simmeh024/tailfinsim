import { fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ContextSelectionProvider, useContextSelection } from '../shell/context-selection';

import { LiveryBuilder } from './LiveryBuilder';

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

function ContextPanelHost({ children }: { children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(true);
  const { selection, attachPanelBody, select } = useContextSelection();

  return (
    <>
      <button type="button" onClick={() => setOpen(false)}>
        Dismiss shell panel
      </button>
      <button
        type="button"
        onClick={() =>
          select({
            kind: 'test-context',
            id: 'replacement',
            title: 'Replacement context',
            body: null,
          })
        }
      >
        Take over context
      </button>
      {open && selection !== null && <div data-testid="panel-host" ref={attachPanelBody} />}
      {children}
    </>
  );
}

function renderInContext(builder: ReactNode) {
  return render(
    <ContextSelectionProvider>
      <ContextPanelHost>{builder}</ContextPanelHost>
    </ContextSelectionProvider>,
  );
}

function DelayedDevelopmentPreview(): ReactNode {
  const [developmentPreview, setDevelopmentPreview] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setDevelopmentPreview(true)}>
        Enable dev identity
      </button>
      <LiveryBuilder
        storageKey="delayed-development-preview"
        airlineName="Review Air"
        storage={new MemoryStorage()}
        developmentPreview={developmentPreview}
      />
    </>
  );
}

describe('M6-03 livery builder UI', () => {
  it('keeps Layers closed for the model-progress view until the player opens it', () => {
    renderInContext(
      <LiveryBuilder
        storageKey="model-progress-layers"
        airlineName="Review Air"
        storage={new MemoryStorage()}
        developmentPreview
      />,
    );

    expect(screen.getByRole('button', { name: 'Show layers 3' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(document.querySelector('.livery-layers')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show layers 3' }));
    expect(screen.getByRole('button', { name: 'Hide layers 3' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(document.querySelector('[data-testid="panel-host"] .livery-layers')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Hide layers 3' }));
    expect(screen.getByRole('button', { name: 'Show layers 3' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(document.querySelector('.livery-layers')).toBeNull();
  });

  it('does not move Layers inline when the shell panel is dismissed', () => {
    const storage = new MemoryStorage();
    renderInContext(
      <LiveryBuilder storageKey="dismiss-layers" airlineName="Review Air" storage={storage} />,
    );

    expect(document.querySelector('[data-testid="panel-host"] .livery-layers')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Primary colour hex'), { target: { value: '#123456' } });
    fireEvent.blur(screen.getByLabelText('Primary colour hex'));
    expect(storage.getItem('dismiss-layers')).toContain('#123456FF');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss shell panel' }));
    expect(document.querySelector('[data-testid="panel-host"]')).toBeNull();
    expect(document.querySelector('.livery-layers')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show layers 3' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(storage.getItem('dismiss-layers')).toContain('#123456FF');
  });

  it('clears its context selection when delayed dev identity closes Layers', () => {
    renderInContext(<DelayedDevelopmentPreview />);

    expect(document.querySelector('[data-testid="panel-host"] .livery-layers')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enable dev identity' }));

    expect(screen.getByRole('button', { name: 'Show layers 3' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(document.querySelector('[data-testid="panel-host"]')).toBeNull();
    expect(document.querySelector('.livery-layers')).toBeNull();
  });

  it('closes Layers when another context selection takes over the hosted panel', () => {
    renderInContext(
      <LiveryBuilder
        storageKey="replaced-layers"
        airlineName="Review Air"
        storage={new MemoryStorage()}
      />,
    );

    expect(document.querySelector('[data-testid="panel-host"] .livery-layers')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take over context' }));

    expect(screen.getByRole('button', { name: 'Show layers 3' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(document.querySelector('.livery-layers')).toBeNull();
    expect(document.querySelector('.livery-layers-inline')).toBeNull();
  });

  it('opens model progress when dev identity arrives and keeps draft edits across preview modes', () => {
    const storage = new MemoryStorage();
    const view = render(
      <LiveryBuilder storageKey="progress" airlineName="Review Air" storage={storage} />,
    );
    expect(screen.queryByRole('button', { name: 'Model progress' })).not.toBeInTheDocument();
    view.rerender(
      <LiveryBuilder
        storageKey="progress"
        airlineName="Review Air"
        storage={storage}
        developmentPreview
      />,
    );
    expect(screen.getByRole('button', { name: 'Model progress' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Show layers 3' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(
      screen.getByRole('group', { name: 'A320neo latest aircraft model with sample livery' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tail detail' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Paint map' }));
    const hex = screen.getByLabelText('Primary colour hex');
    fireEvent.change(hex, { target: { value: '#123456' } });
    fireEvent.blur(hex);
    const saved = storage.getItem('progress');
    fireEvent.click(screen.getByRole('button', { name: '3D preview' }));
    expect(
      screen.getByRole('group', {
        name: 'A320neo quarantined semantic livery authoring review model',
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Model progress' }));
    expect(screen.queryByLabelText('Primary colour hex')).not.toBeInTheDocument();
    expect(storage.getItem('progress')).toBe(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Paint map' }));
    expect(screen.getByLabelText('Primary colour hex')).toHaveValue('#123456FF');
    fireEvent.click(screen.getByRole('button', { name: 'Model progress' }));
    fireEvent.change(screen.getByLabelText('Aircraft family'), { target: { value: 'A380' } });
    expect(screen.queryByRole('button', { name: 'Model progress' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D preview' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    view.unmount();
  });

  it('edits all layer-list properties and restores the autosaved draft after remount', () => {
    const storage = new MemoryStorage();
    const view = render(
      <LiveryBuilder storageKey="test-airline" airlineName="Northwind" storage={storage} />,
    );

    expect(screen.getByRole('heading', { name: 'Northwind' })).toBeInTheDocument();
    expect(screen.getByText('Saved locally')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'A320neo three-dimensional livery preview' }),
    ).toBeInTheDocument();
    const fuselageCoat = document.querySelector(
      '.livery-fleet-preview__coat[data-zone="fuselage"]',
    );
    const wingGuard = document.querySelector('[data-surface-guard="wings"]');
    const engineGuard = document.querySelector('[data-surface-guard="engines"]');
    expect(fuselageCoat).not.toBeNull();
    expect(wingGuard).not.toBeNull();
    expect(engineGuard).not.toBeNull();
    expect(
      fuselageCoat!.compareDocumentPosition(wingGuard!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      wingGuard!.compareDocumentPosition(engineGuard!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.click(screen.getByRole('button', { name: 'Paint map' }));
    expect(document.querySelector('svg[data-rendered-layers="3"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '3D preview' }));

    fireEvent.change(screen.getByLabelText('Aircraft family'), { target: { value: 'A380' } });
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'engine_nacelles' } });
    fireEvent.change(screen.getByLabelText('Fill'), { target: { value: 'radial' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add fill layer' }));

    const name = screen.getByLabelText('Rename Engine Nacelles base');
    expect(screen.getByLabelText('Engine Nacelles base opacity')).toHaveValue('0.72');
    const engineCoat = document.querySelector(
      '.livery-fleet-preview__coat[data-zone="engine_nacelles"]',
    );
    const currentEngineGuard = document.querySelector('[data-surface-guard="engines"]');
    expect(
      currentEngineGuard!.compareDocumentPosition(engineCoat!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    fireEvent.change(name, { target: { value: 'Powerplant wash' } });
    fireEvent.blur(name);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Powerplant wash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock Powerplant wash' }));
    expect(screen.getByLabelText('Powerplant wash opacity')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Powerplant wash' }));
    fireEvent.change(screen.getByLabelText('Powerplant wash opacity'), {
      target: { value: '0.42' },
    });
    fireEvent.change(screen.getByLabelText('Powerplant wash blend mode'), {
      target: { value: 'screen' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move Powerplant wash toward back' }));

    const saved = storage.getItem('test-airline');
    expect(saved).not.toBeNull();
    expect(saved).toContain('Powerplant wash');
    expect(saved).toContain('A380');

    view.unmount();
    render(<LiveryBuilder storageKey="test-airline" airlineName="Northwind" storage={storage} />);
    expect(screen.getByLabelText('Aircraft family')).toHaveValue('A380');
    expect(screen.getByLabelText('Rename Powerplant wash')).toHaveValue('Powerplant wash');
    expect(screen.getByLabelText('Powerplant wash opacity')).toHaveValue('0.42');
    expect(screen.getByLabelText('Powerplant wash blend mode')).toHaveValue('screen');
    expect(screen.getByRole('button', { name: 'Show Powerplant wash' })).toBeInTheDocument();
  });

  it('supports fill modes, HEX/RGB colour entry, palette reuse and complete undo/redo', () => {
    const storage = new MemoryStorage();
    render(
      <LiveryBuilder storageKey="colour-airline" airlineName="Colour Air" storage={storage} />,
    );

    fireEvent.change(screen.getByLabelText('Selected fill mode'), { target: { value: 'split' } });
    expect(screen.getByText('Split position')).toBeInTheDocument();

    const hex = screen.getByLabelText('Primary colour hex');
    fireEvent.change(hex, { target: { value: '#112233' } });
    fireEvent.blur(hex);
    expect(screen.getByLabelText('Primary colour R')).toHaveValue(17);
    expect(screen.getByLabelText('Primary colour G')).toHaveValue(34);
    expect(screen.getByLabelText('Primary colour B')).toHaveValue(51);

    fireEvent.change(screen.getByLabelText('Primary colour R'), { target: { value: '68' } });
    expect(screen.getByLabelText('Primary colour hex')).toHaveValue('#442233FF');
    fireEvent.click(screen.getAllByRole('button', { name: 'Add to palette' })[0]!);
    expect(screen.getByRole('button', { name: 'Use #442233FF' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.queryByRole('button', { name: 'Use #442233FF' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByRole('button', { name: 'Use #442233FF' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(screen.queryByRole('button', { name: 'Use #442233FF' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('button', { name: 'Use #442233FF' })).toBeInTheDocument();
  });

  it('collapses the tool rail while leaving the aircraft and layer controls available', () => {
    render(
      <LiveryBuilder
        storageKey="compact-airline"
        airlineName="Compact Air"
        storage={new MemoryStorage()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide tools' }));
    expect(screen.getByRole('button', { name: 'Show tools' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(
      screen.getByRole('img', { name: 'A320neo three-dimensional livery preview' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Paint map' }));
    expect(document.querySelector('.livery-canvas__aircraft svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Select Tail gradient' })).toBeInTheDocument();
  });
});
