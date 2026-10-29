import * as Checkbox from '@radix-ui/react-checkbox';
import * as Label from '@radix-ui/react-label';
import * as Select from '@radix-ui/react-select';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { AnimatePresence, motion } from 'motion/react';
import { useId, type InputHTMLAttributes } from 'react';
import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';
import { cn } from '@/lib/cn';
import { spring } from '@/lib/motion';
import { CheckIcon, ChevronDownIcon } from './icons';

/*
 * Form controls built on react-hook-form's <Controller>. Every control is controlled by the
 * form, shows its zod error under the field, and links label, hint and error for screen readers.
 *
 * Pattern (see CONTRACT.md): form values are strings, the zod schema transforms them, and
 *   useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({ resolver: zodResolver(schema) })
 */

const fieldBox =
  'w-full rounded-xl border bg-surface-2/70 px-3.5 text-sm text-fg outline-none transition-colors placeholder:text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-50';

type ShellProps = {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
};

/** Label, control, hint and an animated error line. */
export function FieldShell({ id, label, hint, error, children }: ShellProps) {
  return (
    <div className="grid gap-1.5">
      <Label.Root htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </Label.Root>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted">
          {hint}
        </p>
      ) : null}
      <div aria-live="polite">
        <AnimatePresence initial={false}>
          {error ? (
            <motion.p
              id={`${id}-error`}
              key="error"
              initial={{ opacity: 0, height: 0, y: -4 }}
              animate={{ opacity: 1, height: 'auto', y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring.snappy}
              className="overflow-hidden text-xs font-medium text-bad"
            >
              {error}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

function describedBy(
  id: string,
  hint: string | undefined,
  error: string | undefined,
) {
  return (
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(' ') || undefined
  );
}

type Base<T extends FieldValues, O extends FieldValues = T> = {
  control: Control<T, unknown, O>;
  name: FieldPath<T>;
  label: string;
  hint?: string;
};

type InputExtras = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'name' | 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'id'
> & {
  mono?: boolean;
};

export function FormInput<T extends FieldValues, O extends FieldValues = T>({
  control,
  name,
  label,
  hint,
  mono,
  className,
  ...input
}: Base<T, O> & InputExtras) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldShell
          id={id}
          label={label}
          hint={hint}
          error={fieldState.error?.message}
        >
          <input
            {...input}
            id={id}
            ref={field.ref}
            name={field.name}
            value={field.value ?? ''}
            onChange={field.onChange}
            onBlur={field.onBlur}
            aria-invalid={fieldState.invalid || undefined}
            aria-describedby={describedBy(id, hint, fieldState.error?.message)}
            className={cn(
              fieldBox,
              'h-11',
              fieldState.invalid ? 'border-bad' : 'border-line',
              mono && 'font-mono text-[13px]',
              className,
            )}
          />
        </FieldShell>
      )}
    />
  );
}

export type Option = { value: string; label: string };

export function FormSelect<T extends FieldValues, O extends FieldValues = T>({
  control,
  name,
  label,
  hint,
  options,
  placeholder,
}: Base<T, O> & { options: Option[]; placeholder?: string }) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldShell
          id={id}
          label={label}
          hint={hint}
          error={fieldState.error?.message}
        >
          <Select.Root
            value={field.value ?? ''}
            onValueChange={field.onChange}
            name={field.name}
          >
            <Select.Trigger
              id={id}
              ref={field.ref}
              onBlur={field.onBlur}
              aria-invalid={fieldState.invalid || undefined}
              aria-describedby={describedBy(
                id,
                hint,
                fieldState.error?.message,
              )}
              className={cn(
                fieldBox,
                'flex h-11 items-center justify-between gap-2 text-left',
                fieldState.invalid ? 'border-bad' : 'border-line',
              )}
            >
              <Select.Value placeholder={placeholder} />
              <Select.Icon className="text-muted">
                <ChevronDownIcon />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                data-pop
                position="popper"
                sideOffset={6}
                className="z-[60] w-(--radix-select-trigger-width) overflow-hidden rounded-xl border border-line-strong bg-solid p-1 shadow-card"
              >
                <Select.Viewport>
                  {options.map((o) => (
                    <Select.Item
                      key={o.value}
                      value={o.value}
                      className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm text-fg outline-none data-[highlighted]:bg-surface-2"
                    >
                      <Select.ItemText>{o.label}</Select.ItemText>
                      <Select.ItemIndicator className="text-accent">
                        <CheckIcon />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </FieldShell>
      )}
    />
  );
}

/** A single-choice segmented control (e.g. urgency). The selected pill slides between options. */
export function FormToggleGroup<
  T extends FieldValues,
  O extends FieldValues = T,
>({ control, name, label, hint, options }: Base<T, O> & { options: Option[] }) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const value = (field.value as string | undefined) ?? '';
        return (
          <FieldShell
            id={id}
            label={label}
            hint={hint}
            error={fieldState.error?.message}
          >
            <ToggleGroup.Root
              id={id}
              type="single"
              value={value}
              // Radix reports "" when the selected item is clicked again; keep a choice selected.
              onValueChange={(v) => v && field.onChange(v)}
              onBlur={field.onBlur}
              aria-label={label}
              className="relative inline-flex w-full gap-1 rounded-xl border border-line bg-surface-2/70 p-1"
            >
              {options.map((o) => (
                <ToggleGroup.Item
                  key={o.value}
                  value={o.value}
                  className="relative flex-1 rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors outline-none data-[state=on]:text-fg"
                >
                  {value === o.value ? (
                    <motion.span
                      layoutId={`toggle-${id}`}
                      transition={spring.soft}
                      className="absolute inset-0 rounded-lg border border-line-strong bg-solid shadow-sm"
                    />
                  ) : null}
                  <span className="relative">{o.label}</span>
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
          </FieldShell>
        );
      }}
    />
  );
}

export function FormCheckbox<T extends FieldValues, O extends FieldValues = T>({
  control,
  name,
  label,
  hint,
}: Base<T, O>) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <div className="grid gap-1.5">
          <div className="flex items-start gap-3">
            <Checkbox.Root
              id={id}
              ref={field.ref}
              checked={Boolean(field.value)}
              onCheckedChange={(c) => field.onChange(c === true)}
              onBlur={field.onBlur}
              aria-invalid={fieldState.invalid || undefined}
              aria-describedby={describedBy(
                id,
                hint,
                fieldState.error?.message,
              )}
              className={cn(
                'mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border bg-surface-2/70 transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent',
                fieldState.invalid ? 'border-bad' : 'border-line-strong',
              )}
            >
              <Checkbox.Indicator asChild>
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={spring.snappy}
                  className="text-accent-ink"
                >
                  <CheckIcon />
                </motion.span>
              </Checkbox.Indicator>
            </Checkbox.Root>
            <Label.Root
              htmlFor={id}
              className="text-sm leading-relaxed text-fg"
            >
              {label}
            </Label.Root>
          </div>
          {hint ? (
            <p id={`${id}-hint`} className="pl-8 text-xs text-muted">
              {hint}
            </p>
          ) : null}
          {fieldState.error?.message ? (
            <p
              id={`${id}-error`}
              role="alert"
              className="pl-8 text-xs font-medium text-bad"
            >
              {fieldState.error.message}
            </p>
          ) : null}
        </div>
      )}
    />
  );
}
