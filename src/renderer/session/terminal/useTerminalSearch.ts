import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { SearchAddon } from '@xterm/addon-search';

interface TerminalSearchOptions {
  maxFontSize: number;
  minFontSize: number;
  searchAddonRef: RefObject<SearchAddon | null>;
  setFontSize: Dispatch<SetStateAction<number>>;
  /** 当前终端是否处于全屏程序（vim/nano）的 alternate screen：是则不劫持 Ctrl+F。 */
  isAlternateScreenActive?: () => boolean;
}

/** Manages terminal search state and global search/font keyboard shortcuts. */
export function useTerminalSearch({
  maxFontSize,
  minFontSize,
  searchAddonRef,
  setFontSize,
  isAlternateScreenActive,
}: TerminalSearchOptions) {
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'f') {
        // vim/nano 等全屏程序里 ^F 是翻页/前移：不劫持，放行给远端。
        if (isAlternateScreenActive?.()) {
          return;
        }
        event.preventDefault();
        setShowSearch(prev => !prev);
      }
      if (event.ctrlKey && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        setFontSize(prev => Math.min(prev + 2, maxFontSize));
      }
      if (event.ctrlKey && event.key === '-') {
        event.preventDefault();
        setFontSize(prev => Math.max(prev - 2, minFontSize));
      }
      if (event.key === 'Escape' && showSearch) {
        // 关搜索栏的 Esc 不能泄漏给远端，否则 vim 会被意外切出插入模式。
        event.preventDefault();
        event.stopPropagation();
        setShowSearch(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isAlternateScreenActive, maxFontSize, minFontSize, setFontSize, showSearch]);

  useEffect(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findNext(searchQuery);
    }
  }, [searchAddonRef, searchQuery]);

  const searchNext = useCallback(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findNext(searchQuery);
    }
  }, [searchAddonRef, searchQuery]);

  const searchPrevious = useCallback(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findPrevious(searchQuery);
    }
  }, [searchAddonRef, searchQuery]);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery('');
  }, []);

  return {
    closeSearch,
    searchNext,
    searchPrevious,
    searchQuery,
    setSearchQuery,
    setShowSearch,
    showSearch,
  };
}
