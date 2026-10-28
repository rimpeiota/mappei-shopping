'use client';

import { useId, useState } from 'react';

type Option = { value: string; label: string };
type Group = { label: string; options: Option[] };
const names = (values: string[]): Option[] => values.map(value => ({ value, label: value }));
const UNITS: Group[] = [
  { label: '個数・枚数', options: names(['個', '枚', '本', '袋', 'パック', '箱', '缶', 'セット', 'ケース', '束', '株', '玉', '切れ', 'かけ', '台', '着', '足', '組']) },
  { label: '重さ', options: [{ value: 'g', label: 'g（グラム）' }, { value: 'kg', label: 'kg（キログラム）' }] },
  { label: '容量', options: [{ value: 'ml', label: 'ml（ミリリットル）' }, { value: 'L', label: 'L（リットル）' }] },
  { label: '料理の分量', options: names(['合', '大さじ', '小さじ']) },
];
const LOCATIONS: Group[] = [
  { label: '食品・調味料', options: names(['冷蔵庫', '冷凍庫', '野菜室', '調味料', '常温', '食品ストック棚']) },
  { label: 'キッチン', options: names(['キッチンの下', 'キッチンの吊り戸棚', '食器棚', 'パントリー']) },
  { label: '洗面所・トイレ・洗濯', options: names(['洗面台の下', 'トイレの上', '洗濯機の上', '洗面所の棚', '浴室の棚']) },
  { label: '衣類・日用品', options: names(['日用品', 'タンス', 'クローゼット', '押し入れ', '玄関収納', 'リビング収納', '納戸']) },
];
const OTHER = '__picker_custom__';

/** A native select keeps mobile operation simple; custom values stay ordinary strings. */
export function StoragePicker({ label, kind, value, onChange, className = 'field' }: {
  label: string; kind: 'unit' | 'location'; value: string; onChange: (value: string) => void; className?: string;
}) {
  const id = useId();
  const [customEditing, setCustomEditing] = useState(false);
  const groups = kind === 'unit' ? UNITS : LOCATIONS;
  const known = groups.some(group => group.options.some(option => option.value === value));
  const custom = customEditing || (value !== '' && !known);
  return <div className={`${className} storage-picker`}>
    <label htmlFor={id}>{label}</label>
    <select id={id} value={custom ? OTHER : value} onChange={event => {
      const next = event.target.value;
      setCustomEditing(next === OTHER);
      onChange(next === OTHER ? '' : next);
    }}>
      <option value="">未設定</option>
      {groups.map(group => <optgroup key={group.label} label={group.label}>{group.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>)}
      <option value={OTHER}>その他（自由入力）</option>
    </select>
    {custom && <>
      <label htmlFor={`${id}-custom`} className="picker-custom-label">その他の{label}</label>
      <input id={`${id}-custom`} value={value} required maxLength={kind === 'unit' ? 50 : 200}
        placeholder={kind === 'unit' ? '単位を入力' : '場所を入力'} onChange={event => { setCustomEditing(true); onChange(event.target.value); }} />
    </>}
  </div>;
}
