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
}

/** Manages terminal search state and global search/font keyboard shortcuts. */
export function useTerminalSearch({
  maxFontSize,
  minFontSize,
  searchAddonRef,
  setFontSize,
}: TerminalSearchOptions) {
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'f') {
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
        setShowSearch(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [maxFontSize, minFontSize, setFontSize, showSearch]);

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
