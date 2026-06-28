import { forwardRef } from 'react';
import {
  Link as RRLink,
  NavLink as RRNavLink,
  type LinkProps,
  type NavLinkProps,
  type To,
} from 'react-router';
import { useLocale } from './context';
import { localizePath, type Locale } from './locale';

// Locale-aware Link / NavLink. Components MUST import these (not the react-router originals) for any
// in-app navigation, so the active locale prefix sticks across clicks. Targets are written in their
// Bulgarian-rooted form (`to="/companies"`); the wrapper prefixes `/en` when the English locale is
// active. External URLs, hash links and relative paths pass through untouched.

function localizeTo(to: To, locale: Locale): To {
  if (typeof to === 'string') {
    return to.startsWith('/') ? localizePath(to, locale) : to;
  }
  if (to.pathname && to.pathname.startsWith('/')) {
    return { ...to, pathname: localizePath(to.pathname, locale) };
  }
  return to;
}

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, ...rest }, ref) {
  const locale = useLocale();
  return <RRLink ref={ref} to={localizeTo(to, locale)} {...rest} />;
});

export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink(
  { to, ...rest },
  ref,
) {
  const locale = useLocale();
  return <RRNavLink ref={ref} to={localizeTo(to, locale)} {...rest} />;
});
