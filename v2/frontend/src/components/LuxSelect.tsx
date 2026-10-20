import {useEffect, useRef, useState} from 'react';

// The styled dropdown the Python app builds over every <select> (app.js
// "lux-select"), as a React component with the same markup and classes.

interface Option {
    value: string;
    label: string;
}

interface SingleProps {
    multiple?: false;
    options: Option[];
    value: string;
    onChange: (value: string) => void;
}

interface MultiProps {
    multiple: true;
    // Do not include the "All" option: it is added, and selecting it clears the selection.
    options: Option[];
    value: string[];
    onChange: (value: string[]) => void;
}

export function LuxSelect(props: SingleProps | MultiProps) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const close = (event: MouseEvent | KeyboardEvent) => {
            if (event instanceof KeyboardEvent ? event.key === 'Escape' : !wrapRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('click', close);
        document.addEventListener('keydown', close);
        return () => {
            document.removeEventListener('click', close);
            document.removeEventListener('keydown', close);
        };
    }, [open]);

    let triggerText: string;
    if (props.multiple) {
        const selected = props.options.filter(o => props.value.includes(o.value));
        triggerText = !selected.length ? 'All' : selected.length > 2 ? `${selected.length} selected` : selected.map(o => o.label).join(', ');
    } else {
        triggerText = props.options.find(o => o.value === props.value)?.label ?? 'All';
    }

    const options = props.multiple ? [{value: '', label: 'All'}, ...props.options] : props.options;

    function choose(option: Option) {
        if (props.multiple) {
            if (!option.value) props.onChange([]);
            else props.onChange(props.value.includes(option.value) ? props.value.filter(v => v !== option.value) : [...props.value, option.value]);
        } else {
            props.onChange(option.value);
            setOpen(false);
        }
    }

    return (
        <div ref={wrapRef} className={`lux-select${props.multiple ? ' multi' : ''}${open ? ' open' : ''}`}>
            <button type="button" className="lux-select-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
                {triggerText}
            </button>
            <div className="lux-select-menu" role="listbox" aria-multiselectable={props.multiple || undefined}>
                {options.map(option => {
                    const selected = props.multiple ? props.value.includes(option.value) : props.value === option.value;
                    return (
                        <button key={option.value || '(all)'} type="button" role="option" aria-selected={selected}
                                className={`lux-select-option${selected ? ' selected' : ''}`} onClick={() => choose(option)}>
                            {props.multiple ? (
                                <>
                                    <span className="lux-select-check" aria-hidden="true"/>
                                    <span className="lux-select-label">{option.label}</span>
                                </>
                            ) : option.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
