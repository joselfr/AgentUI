import type { ComponentType } from 'react';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import ChecklistOutlined from '@mui/icons-material/ChecklistOutlined';
import BarChartOutlined from '@mui/icons-material/BarChartOutlined';
import CalendarMonthOutlined from '@mui/icons-material/CalendarMonthOutlined';
import StickyNote2Outlined from '@mui/icons-material/StickyNote2Outlined';
import TimerOutlined from '@mui/icons-material/TimerOutlined';
import ShoppingCartOutlined from '@mui/icons-material/ShoppingCartOutlined';
import AccountBalanceWalletOutlined from '@mui/icons-material/AccountBalanceWalletOutlined';
import HomeOutlined from '@mui/icons-material/HomeOutlined';
import StarBorder from '@mui/icons-material/StarBorder';
import MenuBookOutlined from '@mui/icons-material/MenuBookOutlined';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import MusicNoteOutlined from '@mui/icons-material/MusicNoteOutlined';
import CodeOutlined from '@mui/icons-material/CodeOutlined';
import MapOutlined from '@mui/icons-material/MapOutlined';
import MailOutline from '@mui/icons-material/MailOutline';
import PhotoOutlined from '@mui/icons-material/PhotoOutlined';
import SportsEsportsOutlined from '@mui/icons-material/SportsEsportsOutlined';
import RestaurantOutlined from '@mui/icons-material/RestaurantOutlined';
import FlightTakeoffOutlined from '@mui/icons-material/FlightTakeoffOutlined';
import WbSunnyOutlined from '@mui/icons-material/WbSunnyOutlined';
import LightbulbOutlined from '@mui/icons-material/LightbulbOutlined';
import FavoriteBorder from '@mui/icons-material/FavoriteBorder';
import TuneOutlined from '@mui/icons-material/TuneOutlined';

/** Icon names an agent can give to its app (documented in the apps skill). Unknown names fall back to `apps`. */
export const APP_ICONS: Record<string, ComponentType<{ fontSize?: 'small' | 'medium' | 'large' }>> = {
  apps: AppsOutlined, checklist: ChecklistOutlined, chart: BarChartOutlined, calendar: CalendarMonthOutlined, notes: StickyNote2Outlined,
  timer: TimerOutlined, shopping: ShoppingCartOutlined, finance: AccountBalanceWalletOutlined, home: HomeOutlined, star: StarBorder,
  book: MenuBookOutlined, fitness: FitnessCenterOutlined, music: MusicNoteOutlined, code: CodeOutlined, map: MapOutlined,
  mail: MailOutline, photo: PhotoOutlined, game: SportsEsportsOutlined, food: RestaurantOutlined, travel: FlightTakeoffOutlined,
  weather: WbSunnyOutlined, idea: LightbulbOutlined, health: FavoriteBorder, tools: TuneOutlined,
};

export function AppIcon({ name, fontSize = 'medium' }: { name: string; fontSize?: 'small' | 'medium' | 'large' }) {
  const I = APP_ICONS[name] ?? AppsOutlined;
  return <I fontSize={fontSize} />;
}
