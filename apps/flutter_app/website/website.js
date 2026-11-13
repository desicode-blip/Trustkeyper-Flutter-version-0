'use strict';

if (location.hash.startsWith('#/')) location.replace(`https://trustkeyper.web.app/${location.hash}`);

function validateWebsiteContact(values) {
  const errors = {};
  if (!values.firstName.trim()) errors.firstName = 'First name is required';
  if (!values.lastName.trim()) errors.lastName = 'Last name is required';
  if (!/^[6-9]\d{9}$/.test(values.phone)) errors.phone = 'Enter a valid 10-digit mobile number';
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Enter a valid email address';
  if (!['property_owner', 'tenant', 'broker'].includes(values.role)) errors.role = 'Select your role';
  if (!['immediately', 'within_1_month', 'within_3_months', 'within_6_months', 'exploring'].includes(values.serviceTiming)) errors.serviceTiming = 'Select when you need this service';
  if (!values.message.trim()) errors.message = 'Message is required';
  if (values.message.length > 5000) errors.message = 'Message must be at most 5000 characters';
  return errors;
}

for (const toggle of document.querySelectorAll('[data-faq-toggle]')) {
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    for (const other of document.querySelectorAll('[data-faq-toggle]')) {
      const open = other === toggle && !expanded;
      other.setAttribute('aria-expanded', String(open));
      document.getElementById(other.getAttribute('aria-controls')).hidden = !open;
      other.querySelector('svg')?.classList.toggle('rotate-180', open);
    }
  });
}

const menuToggle = document.querySelector('[data-menu-toggle]');
const mobileMenu = document.getElementById('mobile-menu');
function closeWebsiteMenu() {
  if (!menuToggle || !mobileMenu) return;
  mobileMenu.hidden = true;
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Open menu');
}
menuToggle?.addEventListener('click', () => {
  mobileMenu.hidden = !mobileMenu.hidden;
  menuToggle.setAttribute('aria-expanded', String(!mobileMenu.hidden));
  menuToggle.setAttribute('aria-label', mobileMenu.hidden ? 'Open menu' : 'Close menu');
});
mobileMenu?.addEventListener('click', event => {
  if (event.target.closest('a')) closeWebsiteMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeWebsiteMenu();
});

for (const form of document.querySelectorAll('[data-contact-form]')) {
  const submit = form.querySelector('[data-contact-submit]');
  const status = form.querySelector('[data-contact-status]');
  const roleError = document.createElement('p');
  roleError.className = 'mt-1.5 text-xs text-red-600';
  roleError.hidden = true;
  roleError.dataset.fieldError = 'role';
  form.querySelector('[data-contact-role]').parentElement.append(roleError);
  let role = '';
  let sending = false;
  let requestId = crypto.randomUUID();
  let previousPayload = '';
  function values() {
    const data = Object.fromEntries(new FormData(form));
    return { ...data, role };
  }
  function showErrors(errors) {
    for (const output of form.querySelectorAll('[data-field-error]')) {
      const field = output.dataset.fieldError;
      output.textContent = errors[field] ?? '';
      output.hidden = !errors[field];
      form.elements.namedItem(field)?.setAttribute('aria-invalid', String(Boolean(errors[field])));
    }
  }
  function refresh() {
    submit.disabled = sending || Object.keys(validateWebsiteContact(values())).length > 0;
  }
  form.addEventListener('input', event => {
    if (event.target.name === 'phone') event.target.value = event.target.value.replace(/\D/g, '').slice(0, 10);
    const errors = validateWebsiteContact(values());
    const output = form.querySelector(`[data-field-error="${event.target.name}"]`);
    if (output && !output.hidden) showErrors(errors);
    refresh();
  });
  form.addEventListener('change', refresh);
  form.addEventListener('focusout', event => {
    const errors = validateWebsiteContact(values());
    const output = form.querySelector(`[data-field-error="${event.target.name}"]`);
    if (output) {
      output.textContent = errors[event.target.name] ?? '';
      output.hidden = !errors[event.target.name];
      event.target.setAttribute('aria-invalid', String(Boolean(errors[event.target.name])));
    }
  });
  for (const choice of form.querySelectorAll('[data-contact-role]')) {
    choice.addEventListener('click', () => {
      role = choice.dataset.contactRole;
      for (const other of form.querySelectorAll('[data-contact-role]')) other.setAttribute('aria-pressed', String(other === choice));
      roleError.hidden = true;
      refresh();
    });
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending) return;
    const data = values();
    const errors = validateWebsiteContact(data);
    showErrors(errors);
    if (Object.keys(errors).length) {
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    const payload = JSON.stringify(data);
    if (previousPayload && previousPayload !== payload) requestId = crypto.randomUUID();
    previousPayload = payload;
    sending = true;
    refresh();
    submit.textContent = 'Sending...';
    status.textContent = '';
    status.dataset.error = 'false';
    try {
      const response = await fetch('/api/contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, requestId }), signal: AbortSignal.timeout(25000),
      });
      const result = await response.json();
      if (!response.ok || result.accepted !== true) {
        if (result.fields) showErrors(result.fields);
        throw new Error(response.status === 429 ? 'Too many requests. Please try again in an hour or email info@trustkeyper.com.' : 'Your message could not be confirmed. Please retry or email info@trustkeyper.com.');
      }
      form.reset();
      role = '';
      for (const choice of form.querySelectorAll('[data-contact-role]')) choice.setAttribute('aria-pressed', 'false');
      requestId = crypto.randomUUID();
      previousPayload = '';
      status.textContent = 'Thank you for reaching out. We have received your message and our team will get back to you shortly.';
    } catch (error) {
      status.dataset.error = 'true';
      status.textContent = error.name === 'TimeoutError' || error.name === 'TypeError' ? 'We could not confirm delivery. Please retry or email info@trustkeyper.com.' : error.message;
    } finally {
      sending = false;
      submit.textContent = 'Send Message';
      refresh();
    }
  });
  refresh();
}
